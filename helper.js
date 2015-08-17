var bitcore = require('bitcore')

exports.getAddress = function (masterKey, path) {
  return masterKey.derive(path).privateKey.toAddress().toString()
}

exports.getMasterKey = function (seed) {
  return bitcore.HDPrivateKey.fromSeed(new Buffer(seed, 'hex'), 
                                       bitcore.Networks.testnet)
}

exports.generateSeed = function () {
  return bitcore.crypto.Random.getRandomBuffer(64).toString('hex')
}
    
var bitcoinNetwork = bitcore.Networks.testnet

exports.getOutputCoins = function (txHex) {
  var tx = new bitcore.Transaction(txHex)
  return tx.outputs.map(function (output, idx) {
      return {
        txId: tx.id,
        outIndex: idx,
        value: output.satoshis,
        script: output.script.toHex(),
        address: output.script.toAddress(bitcoinNetwork).toString()
      }
  })
}