var helper = require('../helper')
var Client = require('../client')
var test = require('./test')
var _ = require('lodash')
var crypto = require('crypto')

function makeRandomId() {
  return crypto.randomBytes(8).toString('hex')
}

function sendTestCoins(toAddress) {
  var fundingWalletSeed = "04df1a94ff0339ab7f5cd9c1e78deaed4b771701f3411efb95825a8a73ce864edf1aefc48bba7135f7da431a807d4501445809c7564624131940b953dcf99401"
  var fundingAmount = 200000 
  var fundingMasterKey = helper.getMasterKey(fundingWalletSeed)
  var fundingAddress = helper.getAddress(fundingMasterKey, 'm/0/0')
  var client = new Client(test.getUrl())
  return client.getUnspentCoins([fundingAddress], '').then(function (coins) {
    if (_.sum(coins, 'value') < fundingAmount * 1.1) {
      console.log(_.sum(coins, 'value'), 'found, ', 
        fundingAmount * 1.1, ' wanted')
      console.log('please send some testcoins to ' + fundingAddress)
      throw new Error('not enough money in funding address')
    } else {
      return client.createTransferTx({
          targets: [{address: toAddress, value: fundingAmount, color: ''}],
          sourceAddresses: {
            "": [fundingAddress]
          },
          changeAddress: {
            "": fundingAddress
          }
      }).then(function (res) {
        var tx = helper.decodeTransaction(res.tx, res.inputCoins)
        console.log(res.inputCoins)
        var signatures = _.range(0, res.inputCoins.length).map(function (inputIndex) {
          console.log(inputIndex)
          return helper.makeTxSignature(tx, fundingMasterKey, 'm/0/0', inputIndex)
        })
        return client.broadcastTx(
          helper.finalizeTransaction(tx, signatures).txHex)
      })
    }
  })
}

function runCommand(name) {
  console.log('running ', name)
  return test.commands[name]().then(function () {
    console.log(name, " ok")
    return
  })
}

function runCommands(promise, commands) {
  commands.forEach(function (command) {
    promise = promise.then(function () {
      return runCommand(command)
    })
  })
  return promise
}

function runTest() {
  var fname = makeRandomId() + '.json'
  test.setFileName(fname)
  
  var promise = runCommand('generate').then(function () {
    return test.commands.show_funding_addresses().then(function (address) {
      console.log('sending funding to ' + address)
      return sendTestCoins(address)
    })
  })
  return runCommands(promise, [
                       'sync', 
                       'issue_coins',
                       'sign_pending_txs',
                       'broadcast_txs',
                       'generate_user', 'generate_user',
                       'sync',
                       'distribute_tokens',
                       'sign_pending_txs', 'broadcast_txs', 'sync',
                       'transfer_tokens',
                       'sign_pending_txs', 'broadcast_txs', 'sync'])
  .done(function () {
    console.log("ALL OK, see:", fname)
  }, function (err) {
    console.error(err.stack || err)
    console.log("state: ", fname)
  })
                       
}

runTest()