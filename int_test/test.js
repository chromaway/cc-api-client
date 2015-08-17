var nopt = require('nopt')
var bitcore = require('bitcore')
var Q = require('q')
var fs = require('fs')
var helper = require('../helper')
var Client = require('../client')

var args = nopt({url: String, fname: String, command: String})

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
    return saveState(state)
  })
}

function makeNewAddressPath(state, pathPrefix) {
  if (state.hdPaths === undefined) state.hdPaths = {}
  if (state.hdPaths[pathPrefix] === undefined) state.hdPaths[pathPrefix] = -1
  state.hdPaths[pathPrefix] += 1
  return pathPrefix + '/' + state.hdPaths[pathPrefix].toString()
}

var wPaths = {
  bitcoin: 'm/0/0'
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

function registerNewAddress (state, address, path) {
  if (state.knownAddresses === undefined) state.knownAddresses = {}
  state.knownAddresses[address] = path 
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
    return client.getTx(txRecord.txId).then(function (tx) {
      helper.getOutputCoins(tx).forEach(function (coin) {
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