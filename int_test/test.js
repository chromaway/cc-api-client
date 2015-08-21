var nopt = require('nopt')
var bitcore = require('bitcore')
var Q = require('q')
var fs = require('fs')
var helper = require('../helper')
var Client = require('../client')
var _ = require('lodash')

var args = nopt({dry: Boolean, url: String})

var fname = args.argv.remain.shift()
var command = args.argv.remain.shift()

var commands = {}
var command_args = {}

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

function makeMultiSigAddress(state, userId, masterKey, userMasterKey) {
  var pathPrefix = wPaths.cosign + userId.toString()
  var path = makeNewAddressPath(state, pathPrefix)
  // both wallets use the same path
  var pubkey1 = helper.getPublicKey(masterKey, path)
  var pubkey2 = helper.getPublicKey(userMasterKey, path)
  var address = helper.makeMultiSigAddress([pubkey1, pubkey2])
  return registerNewAddress(state, address, {type: "P2SH/multisig", path: path, userId: userId})
}

var wPaths = {
  bitcoin: 'm/0/0',
  colored: 'm/1',
  cosign: 'm/2'
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

// generate a user for testing multi-sig
commands.generate_user = function () {
  return withState(function (state) {
    if (state.lastUserId === undefined) state.lastUserId = 0
    state.lastUserId += 1
    var userId = state.lastUserId
    if (state.users === undefined) state.users = {}
    state.users[userId] = {
      seed: helper.generateSeed()
    }
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

function commitCoins(state, selectedCoins, inputCoins, commitment) {
  // note: used coins go in same order as input coins
  var usedCoins = []
  inputCoins.forEach(function (iCoin) {
    var coin = _.find(selectedCoins, 
      {txId: iCoin.txId, outIndex: iCoin.outIndex})
    if (coin) {
      coin.committed = commitment
      // We need to store coin in the pending transaction itself.
      // It will be used for collecting signatures.
      var txCoin = _.clone(coin)
      // For now just the simplest case: P2PKH
      var path = state.knownAddresses[coin.address]
      if (path && _.isString(path))
        txCoin.signatures = [{userId: 0, path: path}]
      else
        throw new Exception('TODO: handle multisig')
      usedCoins.push(txCoin)
    } else {
      throw new Error('input coin not found ', iCoin)
    }
  })
  return usedCoins        
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
      if (!_.isArray(res.inputCoins)) throw new Error('got bad reply from service')
      var purpose = {type:'issue', colorPath: colorPath}
      var usedCoins = commitCoins(state, uncoloredCoins, res.inputCoins, purpose)
      var pendingTx = {
        txHex: res.tx,
        purpose: purpose,
        coins: usedCoins
      }
      state.pendingTransactions.push(pendingTx)
    })
  })
}

commands.sign_pending_txs = function () {
  return withState(function (state) {
    if (!state.pendingTransactions || state.pendingTransactions.length === 0) {
      console.log('nothing to sign')
      return
    }
    var masterKey = helper.getMasterKey(state.seed)
    state.pendingTransactions.forEach(function (pendingTx) {
      var tx = helper.decodeTransaction(pendingTx.txHex, pendingTx.coins)
      pendingTx.coins.forEach(function (coin, inputIndex) {
        coin.signatures.forEach(function (signatureS) {
          if (signatureS.signature) return // signature already provided
          if (signatureS.userId === 0) { // our
            var path = signatureS.path
            console.log('signing ' + path)
            var signature = helper.makeTxSignature(tx, masterKey, path, inputIndex)
            console.log(signature)
            signatureS.signature = signature
          } else {
            console.log(' need signature from ' + signatureS.user_id + ' ' + signatureS.path)
          }
        })
      })
    })
  })
}

commands.broadcast_txs = function () {
  return withState(function (state) {
    if (!state.pendingTransactions || state.pendingTransactions.length === 0) {
      console.log('nothing to broadcast')
      return null
    }
    var broadcastTxs = []
    var processedTransactions = []
    state.pendingTransactions.forEach(function (pendingTx) {
      var signatures = []
      var missing = false
      pendingTx.coins.forEach(function (coin) {
        coin.signatures.forEach(function (signatureS) {
          if (signatureS.signature)
            signatures.push(signatureS.signature)
          else {
            console.log(' need signature from ' + signatureS.user_id + ' ' + signatureS.path)
            missing = true
          }          
        })
      })
      if (missing) {
        console.log('pending transaction lacks some signatures')
      } else {
        var tx = helper.decodeTransaction(pendingTx.txHex, pendingTx.coins)
        var finTx = helper.finalizeTransaction(tx, signatures)
        console.log('txId:', finTx.txId)
        console.log('txHex:', finTx.txHex)
        broadcastTxs.push(finTx)
        processedTransactions.push(pendingTx)
      }
    })
    state.pendingTransactions = _.without(state.pendingTransactions,
                                          processedTransactions)
    if (broadcastTxs.length) {
      return client.getMonitoringGroup(state.mGroupId)
        .then(function (mg) {
            return Q.all(broadcastTxs.map(function (tx) {
              return mg.addTx(tx.txId).then(function () {
                console.log(tx.txId, ' monitored, broadcasting...')
                return client.broadcastTx(tx.txHex)
              }).then(function () {
                // we can do this only after it is broadcasted because
                // we do API calls
                return processTxRecord(state, {
                  txId: tx.txId, status: 'unconfirmed'
                })
              })
            }))
        })      
    } else return null
  })  
}

commands.transfer_tokens = function () {
  return withState(function (state) {
    var userId = 1
    if (!state.users || state.users[userId] === undefined) throw new Error('user not found')
    var masterKey = helper.getMasterKey(state.seed)
    var userMasterKey = helper.getMasterKey(state.users[userId].seed)
    console.log(makeMultiSigAddress(state, userId, masterKey, userMasterKey))
        
    
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
  console.log("usage: node test.js state.json command")
  console.log('commands: ', _.keys(commands))
}