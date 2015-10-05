var bitcore = require('bitcore')
var _ = require('lodash')
var Q = require('q')

var bitcoinNetwork = bitcore.Networks.testnet

exports.setBitcoinNetwork = function (networkName) {
  bitcoinNetwork = bitcore.Networks.get(networkName)
}

exports.getAddress = function (masterKey, path) {
  return masterKey.derive(path).privateKey.toAddress().toString()
}

exports.getPublicKey = function (masterKey, path) {
  return masterKey.derive(path).privateKey.publicKey
}

exports.getExtendedPublicKey = function (masterKey, path) {
  return masterKey.derive(path).xpubkey
}

exports.makeMultiSigAddress = function (publicKeys) {
  return bitcore.Address(publicKeys, publicKeys.length,
                         bitcoinNetwork).toString()
}

exports.getMasterKey = function (seed) {
  return bitcore.HDPrivateKey.fromSeed(new Buffer(seed, 'hex'), 
                                       bitcore.Networks.testnet)
}

exports.generateSeed = function () {
  return bitcore.crypto.Random.getRandomBuffer(64).toString('hex')
}
    
exports.getOutputCoins = function (txHex, colorValues) {
  var tx = new bitcore.Transaction(txHex)
  return tx.outputs.map(function (output, idx) {
      var color = '', 
          colorValue = output.satoshis
      if (colorValues && colorValues[idx]) {
        color = colorValues[idx].color
        colorValue = colorValues[idx].value
      }
        
      return {
        txId: tx.id,
        outIndex: idx,
        value: output.satoshis,
        color: color, 
        colorValue: colorValue,
        script: output.script.toHex(),
        address: output.script.toAddress(bitcoinNetwork).toString()
      }
  })
}

function getTxOutputCoins (client, txId) {
  return Q.all([client.getTx(txId), client.getTxColorValues(txId)])
  .spread(function (txHex, colorValues) {
      return exports.getOutputCoins(txHex, colorValues)
  })
}

exports.getTxInfo = function (client, txId) {
  return client.getTx(txId).then(function (txHex) {
    var tx = new bitcore.Transaction(txHex)
    return Q.all(tx.inputs.map(function (input, idx) {
      var inputObject = input.toObject()
      return getTxOutputCoins(client, inputObject.prevTxId)
      .then(function (coins) { return coins[inputObject.outputIndex] })
    }))
  }).then(function (inputCoins) {
    return Q.all([getTxOutputCoins(client, txId), inputCoins])
  }).spread(function (outputCoins, inputCoins) {
    return {
      inputCoins: inputCoins,
      outputCoins: outputCoins
    }
  })  
}

exports.decodeTransaction = function (txHex, coins) {
  var tx = new bitcore.Transaction(txHex)
  tx.inputs.forEach(function (input, index) {
    var script = bitcore.Script.fromHex(coins[index].script)
    input.output = bitcore.Transaction.Output(
      {script: script, satoshis: coins[index].value})
    var info = script.getAddressInfo()
    if (!info) throw new Error("couldn't understand script " + script.toASM())
    var inputClass
    if (info.type === bitcore.Address.PayToScriptHash) {
      var multisigInfo = coins[index].multisig
      if (multisigInfo === undefined) 
        throw new Error('no info about multisig input')
      var pubkeys = multisigInfo.pubkeys.map(function(pubkey) {
          return new bitcore.PublicKey(pubkey)
      })
      tx.inputs[index] = new bitcore.Transaction.Input.MultiSigScriptHash(
        input.toObject(), pubkeys, multisigInfo.threshold)
    } else if (info.type === bitcore.Address.PayToPublicKeyHash) {
      tx.inputs[index] = new bitcore.Transaction.Input.PublicKeyHash(input.toObject())
    } else throw new Error("do not understand output script " + script.toASM())    
  })
  return tx
}

exports.makeTxSignature = function (decodedTx, masterKey, path, inputIndex) {
  var privateKey = masterKey.derive(path).privateKey
  var hashData = bitcore.crypto.Hash.sha256ripemd160(privateKey.publicKey.toBuffer())
  var input = decodedTx.inputs[inputIndex]
  var signatures = input.getSignatures(
    decodedTx, privateKey,
    inputIndex, bitcore.crypto.Signature.SIGHASH_ALL,
    hashData)

  if (signatures.length !== 1) {
    throw new Error('got ' + signatures.length + ' signatures, expect 1')
  }

  return signatures[0].toObject()
}

exports.finalizeTransaction = function (decodedTx, signatures) {
  signatures.forEach(function (signature) {
    signature = new bitcore.Transaction.Signature(signature)
    decodedTx.applySignature(signature)
  })
  if (!decodedTx.isFullySigned()) throw new Error('not enough signatures')
  return {
    txHex: decodedTx.toString(),
    txId: decodedTx.id
  }
}

exports.makeColorDesc = function (txId) {
  return "epobc:" + txId + ":0:0"
}