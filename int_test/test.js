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

function makeNewMultiSigAddress(state, userId, masterKey, userMasterKey) {
  var pathPrefix = wPaths.cosign + '/' + userId.toString()
  var path = makeNewAddressPath(state, pathPrefix)
  // both wallets use the same path
  var pubkey1 = helper.getPublicKey(masterKey, path)
  var pubkey2 = helper.getPublicKey(userMasterKey, path)
  var address = helper.makeMultiSigAddress([pubkey1, pubkey2])
  if (state.multiSigAddresses === undefined) state.multiSigAddresses = {}
  state.multiSigAddresses[address] = { pubkeys: [pubkey1.toString(),
                                                 pubkey2.toString()], 
                                       threshold: 2  }
  return registerNewAddress(state, address, path)
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
  var address
  return withState(function (state) {
    var masterKey = helper.getMasterKey(state.seed)
    // generate a new one
    var path = makeNewAddressPath(state, wPaths.bitcoin)
    address = helper.getAddress(masterKey, path)
    registerNewAddress(state, address, path)
    return client.getMonitoringGroup(state.mGroupId)
      .then(function (mg) {
        return mg.addAddress(address)
      }).then(function () {
        console.log(getAllFundingAddresses(state, masterKey))
        return address
      })
  }).then(function () {return address})
}

// we structure wallet in particular way and thus can
// find information about owner and type of address
// from path
function decodeAddressPath(path) {
  var parts = path.split('/')
  var res = {
    isMultiSig: parts[1] === '2',
    isColored: parseInt(parts[1]) > 0    
  }
  if (parts[1] === '2') {
    res.userId = parseInt(parts[2])
  } else {
    res.userId = 0
  }
  return res
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
          var addressInfo = decodeAddressPath(knownAddresses[coin.address])
          if (addressInfo.isMultiSig) {
            var multiSigInfo = state.multiSigAddresses[coin.address]
            if (multiSigInfo === undefined) throw new Error('no info about multisig address ' + coin.address)
            coin.multisig = multiSigInfo
          }
          coin.userId = addressInfo.userId
          coin.status = txRecord.status
          if (txRecord.blockHeight)
            coin.blockHeight = txRecord.blockHeight
          console.log(coin)
          state.coins.push(coin)
        } else {
          console.log('WARNING: unknown address ', coin.address)
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

function selectCoins(state, color, userId) {
  if (!state.coins) throw new Error('no coins')
  if (userId === undefined) userId = 0
  var ccoins =  _.filter(state.coins, {color: color, userId: userId})
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
      var path = state.knownAddresses[coin.address]
      var addressPathInfo = decodeAddressPath(path)
      if (addressPathInfo.isMultiSig) {
        txCoin.signatures = [
          { userId: 0, path: path },
          { userId: addressPathInfo.userId, path: path }
        ]
      } else {
        txCoin.signatures = [{userId: 0, path: path}]
      }
      usedCoins.push(txCoin)
    } else {
      throw new Error('input coin not found ', iCoin)
    }
  })
  return usedCoins        
}

// second parameter is a result of create*Tx API calls
function registerPendingTransaction(state, res, selectedCoins, purpose) {
  if (state.pendingTransactions === undefined) state.pendingTransactions = []
  if (!_.isArray(res.inputCoins)) throw new Error('got bad reply from service')
  var usedCoins = commitCoins(state, selectedCoins, res.inputCoins, purpose)
  var pendingTx = {
    txHex: res.tx,
    purpose: purpose,
    coins: usedCoins
  }
  state.pendingTransactions.push(pendingTx)
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
      var purpose = {type:'issue', colorPath: colorPath}
      registerPendingTransaction(state, res, uncoloredCoins, purpose)
      return
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
          var path = signatureS.path
          console.log('signing ' + path + ' as ' + signatureS.userId)
          var signMasterKey
          if (signatureS.userId === 0) {
            signMasterKey = masterKey // our
          } else {
            // sign as other user (normally happens in browser)
            signMasterKey = helper.getMasterKey(state.users[signatureS.userId].seed)
          }
          var signature = helper.makeTxSignature(tx, signMasterKey, path, inputIndex)
          console.log(signature)
          signatureS.signature = signature
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
        finTx.purpose = pendingTx.purpose
        broadcastTxs.push(finTx)
        processedTransactions.push(pendingTx)
      }
    })
    state.pendingTransactions = _.difference(state.pendingTransactions,
                                          processedTransactions)
    if (broadcastTxs.length) {
      return client.getMonitoringGroup(state.mGroupId)
        .then(function (mg) {
            return Q.all(broadcastTxs.map(function (tx) {
              return mg.addTx(tx.txId).then(function () {
                console.log(tx.txId, ' monitored, broadcasting...')
                return client.broadcastTx(tx.txHex)
              }).then(function () {
                if (tx.purpose.type === 'issue') {
                  // register issued color
                  if (state.tokenColors === undefined) state.tokenColors = {}
                  state.tokenColors[tx.purpose.colorPath] = helper.makeColorDesc(tx.txId)                  
                }                        
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

function selectSourceCoins(state, coinKinds) {
  var sourceCoins = {}
  coinKinds.forEach(function (coinKind) {
    sourceCoins[coinKind.color] = selectCoins(state, coinKind.color, coinKind.userId)
  })
  return sourceCoins
}

// from operator to user
commands.distribute_tokens = function () {
  return withState(function (state) {
    var colorPath = 'm/1/0'
    var color = state.tokenColors['m/1/0']
    if (color === undefined) throw new Error('unknown token')
    var userId = 1
    if (!state.users || state.users[userId] === undefined) throw new Error('user not found')
    var masterKey = helper.getMasterKey(state.seed)
    var userMasterKey = helper.getMasterKey(state.users[userId].seed)
    var targetAddress = makeNewMultiSigAddress(state, userId, masterKey, userMasterKey)
    var sourceCoins = selectSourceCoins(state, [
                                          {color: "", userId: 0}, 
                                          {color: color, userId:0}])
    var selectedCoins = _.flatten(_.values(sourceCoins))
    var changeAddress = {}
    changeAddress[""] = getAllFundingAddresses(state, masterKey)[0]
    changeAddress[color] = makeNewAddress(state, masterKey, colorPath)
    var txSpec = {
      targets: [{address: targetAddress, color: color, value: 1}],
      sourceCoins: sourceCoins,
      changeAddress: changeAddress
    }
    return client.createTransferTx(txSpec).then(function(res) {
      var purpose = {type:'transfer', colorPath: colorPath, userId: userId}
      registerPendingTransaction(state, res, selectedCoins, purpose)
      return
    })
  })
}

// from user to user (multi-sig)
commands.transfer_tokens = function () {
  return withState(function (state) {
    var colorPath = 'm/1/0'
    var color = state.tokenColors['m/1/0']
    if (color === undefined) throw new Error('unknown token')
    var senderUserId = 1
    var receiverUserId = 2
    if (!state.users || state.users[senderUserId] === undefined) throw new Error('user not found')
    if (state.users[receiverUserId] === undefined) throw new Error('user not found')
    var masterKey = helper.getMasterKey(state.seed)
    var senderMasterKey = helper.getMasterKey(state.users[senderUserId].seed)
    var receiverMasterKey = helper.getMasterKey(state.users[receiverUserId].seed)
    var targetAddress = makeNewMultiSigAddress(state, receiverUserId, masterKey, receiverMasterKey)
    var sourceCoins = selectSourceCoins(state, [
                                          {color: "", userId: 0},
                                          {color: color, userId: senderUserId}])
    var selectedCoins = _.flatten(_.values(sourceCoins))
    var changeAddress = {}
    changeAddress[""] = getAllFundingAddresses(state, masterKey)[0]
    // TODO: check if we even need change
    changeAddress[color] = makeNewMultiSigAddress(state, senderUserId, masterKey, senderMasterKey)
    var txSpec = {
      targets: [{address: targetAddress, color: color, value: 1}],
      sourceCoins: sourceCoins,
      changeAddress: changeAddress
    }
    return client.createTransferTx(txSpec).then(function(res) {
      var purpose = {type:'transfer', colorPath: colorPath, senderUserId: senderUserId, receiverUserId: receiverUserId}
      registerPendingTransaction(state, res, selectedCoins, purpose)
      return
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
          console.log(command, '- ok')
          process.exit(0)
        }, function (err) {
          console.log(err.stack || err)
          process.exit(1)
        })
} else {
  console.log('command not recognized')
  console.log("usage: node test.js state.json command")
  console.log('commands: ', _.keys(commands))
  // process.exit(2)
}

function setFileName(_fname) {  fname = _fname }

module.exports = {
  commands: commands,
  setFileName: setFileName,
  getUrl: function () {
    return url
  }
}