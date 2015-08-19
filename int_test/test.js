var nopt = require('nopt')
var bitcore = require('bitcore')
var Q = require('q')
var fs = require('fs')
var helper = require('../helper')
var Client = require('../client')
var _ = require('lodash')

var args = nopt({dry: Boolean, url: String, fname: String, command: String})

var fname = args.argv.remain.shift() || args.fname
var command = args.argv.remain.shift() || args.command || 'show'

var commands = {}

var url = args.url || 'http://localhost:4444/api/'
var client = new Client(url)

function getState() {
  return Q.nfcall(fs.readFile, fname).then(function (data) {
    return JSON.parse(data)
  })
}

function saveState(state) {
  return Q.nfcall(fs.writeFile, fname, JSON.stringify(state))
}

function withState (fun) {
  var state
  return getState().then(function (_state) {
    state = _state
    return state
  }).then(fun).then(function () {
    if (!args.dry) return saveState(state)
  })
}

function makeNewAddressPath(state, pathPrefix) {
  if (state.hdPaths === undefined) state.hdPaths = {}
  if (state.hdPaths[pathPrefix] === undefined) state.hdPaths[pathPrefix] = -1
  state.hdPaths[pathPrefix] += 1
  return pathPrefix + '/' + state.hdPaths[pathPrefix].toString()
}

function registerNewAddress (state, address, path) {
  if (state.knownAddresses === undefined) state.knownAddresses = {}
  state.knownAddresses[address] = path 
  return address
}

function makeNewAddress (state, masterKey, pathPrefix) {
  var path = makeNewAddressPath(state, pathPrefix)
  var address = helper.getAddress(masterKey, path)
  return registerNewAddress(state, address, path)
}

var wPaths = {
  bitcoin: 'm/0/0',
  colored: 'm/1',
}


commands.generate = function () {
  return client.newMonitoringGroup().then(function (mg) {
    var state = {
      mGroupId: mg.getId(),
      seed: helper.generateSeed()
    }
    return Q.nfcall(fs.writeFile, fname, JSON.stringify(state))
  })
}

function getAllFundingAddresses(state, masterKey) {
  var maxIndex = state.hdPaths[wPaths.bitcoin]
  var addresses = []
  for (var i = 0; i <= maxIndex; i++) {
    addresses.push(helper.getAddress(masterKey, wPaths.bitcoin + '/' + i))
  }
  return addresses
}


commands.show_funding_addresses = function () {
  return withState(function (state) {
    var masterKey = helper.getMasterKey(state.seed)
    // generate a new one
    var path = makeNewAddressPath(state, wPaths.bitcoin)
    var address = helper.getAddress(masterKey, path)
    registerNewAddress(state, address, path)
    return client.getMonitoringGroup(state.mGroupId)
      .then(function (mg) {
        return mg.addAddress(address)
      }).then(function () {
        console.log(getAllFundingAddresses(state, masterKey))
      })
  })
}

function processTxRecord(state,  txRecord) {
  if (state.coins === undefined) state.coins = []
  var knownAddresses = state.knownAddresses || {}
  if (state.txIds[txRecord.txId] === undefined) {
    // previously unknown transaction
    state.txIds[txRecord.txId] = true
    return Q.all([client.getTx(txRecord.txId),
                  client.getTxColorValues(txRecord.txId)])
    .spread(function (tx, colorValues) {
      helper.getOutputCoins(tx, colorValues).forEach(function (coin) {
        if (knownAddresses[coin.address] !== undefined) {
          coin.status = txRecord.status
          if (txRecord.blockHeight)
            coin.blockHeight = txRecord.blockHeight
          console.log(coin)
          state.coins.push(coin)
        }
      })
    })
  } else {
    state.coins.forEach(function (coin) {
      if (coin.txId === txRecord.txId) {
        coin.status = txRecord.status
        if (txRecord.blockHeight)
          coin.blockHeight = txRecord.blockHeight
        console.log('update', coin)
      }
    })
  }
}

commands.sync = function () {
  return withState(function (state) {
    if (state.txIds === undefined) state.txIds = {}
    return client.getMonitoringGroup(state.mGroupId)
      .then(function (mg) {
        return mg.getLog(state.lastPoint)
      }).then(function (mgLog) {
        state.lastPoint = mgLog.lastPoint
        return Q.all(mgLog.txStates.map(function (txRecord) {
            console.log(txRecord)
            return processTxRecord(state, txRecord)
        }))
      })
  })
}

function selectCoins(state, color) {
  if (!state.coins) throw new Error('no coins')
  var ccoins =  _.filter(state.coins, {color: color})
  return _.reject(ccoins, 'committed')
}

commands.issue_coins = function () {
  return withState(function (state) {
    var masterKey = helper.getMasterKey(state.seed)
    var uncoloredCoins = selectCoins(state, '')
    if (uncoloredCoins.length === 0) throw new Error('no uncolored coins in the wallet')
    var colorPath = makeNewAddressPath(state, wPaths.colored)
    var targetAddress = makeNewAddress(state, masterKey, colorPath)
    var targetAmount = 10000
    var changeAddress = getAllFundingAddresses(state, masterKey)[0]

    var txSpec = {
      target: { address: targetAddress, value: targetAmount },
      sourceCoins: { "": uncoloredCoins }, // API only needs txId and outIndex properties
      changeAddress: { "": changeAddress },
      colorKernel: "epobc"
    }
    return client.createIssueTx(txSpec).then(function(res) {
      if (state.pendingTransactions === undefined) state.pendingTransactions = []
      if (!_.isArray(res.inputCoins)) throw new Error('lacking res.input_coins')
      var usedCoins = []
      // commit coins
      uncoloredCoins.forEach(function (coin) {
          if (_.find(res.inputCoins, {txId: coin.txId, outIndex: coin.outIndex})) {
            usedCoins.push(coin)
            coin.committed = {type:'issue', colorPath: colorPath}
          }
      })
      var pendingTx = {
        txHex: res.tx,
        // we use same object, but add more fields
        singatures: usedCoins
      }
      state.pendingTransactions.push(pendingTx)
    })
  })
}


commands.show_coins = function () {
  return withState(function (state) {
    console.log(state.coins)
  })
}


if (commands[command]) {
  commands[command]()
      .done(
        function () {
          console.log('ok')
        }, function (err) {
          console.log(err.stack || err)
        })
} else {
  console.log('command not recognized')
}