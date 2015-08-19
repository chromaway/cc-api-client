var request = require('request')
var inherits = require('util').inherits
var Q = require('q')
var _ = require('lodash')

function BaseClient(url) {
  this.url = url
}

BaseClient.prototype._postRequest = function (method, data) {
  return Q.nfcall(request, {
    method: 'POST', 
    uri: this.url + method, 
    body: data, 
    json: true})
  .spread(function (response, body) {
    if (response.statusCode !== 200)
      throw new Error('server returned status code ' + response.statusCode)
    return body
  })
}

BaseClient.prototype._getRequest = function (method, data) {
  var queryString = _.map(data, function (val, key) {
    return [key, val].map(encodeURIComponent).join('=')
  }).join('&')
  return Q.nfcall(request, {
    method: 'GET', 
    uri: this.url + method + '?' + queryString,
    json: true})
  .spread(function (response, body) {
    if (response.statusCode !== 200)
      throw new Error('server returned status code ' + response.statusCode)
    return body
  })
}

function APIClient (url) {
  this.url = url
}

inherits(APIClient, BaseClient)

APIClient.prototype.createIssueTx = function (data) {
  return this._postRequest('createIssueTx', data)
}

APIClient.prototype.createTransferTx = function (data) {
  return this._postRequest('createTransferTx', data)
}

APIClient.prototype.getTx = function (txId) {
  return this._getRequest('getTx', {txId: txId}).then(function (res) {
    return res.tx
  })
}

APIClient.prototype.newMonitoringGroup = function () {
  var self = this
  return this._postRequest('tsm/newMonitoringGroup', {})
      .then(function (res) {
          return new TSMClient(self.url, res.groupId)
      })
}

APIClient.prototype.getMonitoringGroup = function (groupId) {
  return Q(new TSMClient(this.url, groupId))
}

APIClient.prototype.broadcastTx = function (txHex) {
  return this._postRequest('broadcastTx', {tx: txHex})
}

APIClient.prototype.getUnspentCoins = function (addresses, color) {
  return this._postRequest('getUnspentCoins',
                           {addresses: addresses, color: color})
}

APIClient.prototype.getAllColoredCoins = function (color, unspent) {
  if (!unspent) unspent = false
  return this._getRequest('getAllColoredCoins',
                           {color: color, unspent: unspent})
}

APIClient.prototype.getTxColorValues = function (txId, outIndices) {
  var data = {txId: txId}
  if (outIndices !== undefined) {
    if (_.isArray(outIndices) || outIndices === null)
      data.outIndices = outIndices
    else
      data.outIndex = outIndices
  }

  return this._postRequest('getTxColorValues', data).then(function (res) {
    return res.colorValues
  })
}

APIClient.prototype.getTxOutputColorValue = function (txId, outIndex) {
  return this._postRequest('getTxColorValues', {txId: txId, outIndex: outIndex}).then(function (res) {
    return res.colorValues[outIndex]
  })  
}

function TSMClient(url, groupId) {
  this.url = url
  this.groupId = groupId
  this.lastPoint = null
}

inherits(TSMClient, BaseClient)

TSMClient.prototype.getId = function () {
  return this.groupId
}

TSMClient.prototype.addTx = function (txId) {
  return this._postRequest('/tsm/addTx', 
    {groupId: this.groupId, txId: txId})
}

TSMClient.prototype.addAddress = function (address) {
  return this._postRequest('/tsm/addAddress', 
    {groupId: this.groupId, address: address})
}

TSMClient.prototype.getUpdates = function () {
  var self = this
  return this._postRequest('/tsm/getLog', 
    {groupId: this.groupId, fromPoint: this.lastPoint})
  .then(function (res) {
    self.lastPoint = res.lastPoint
    return res.txStates
  })
}

TSMClient.prototype.getLog = function (fromPoint) {
  return this._postRequest('/tsm/getLog', 
    {groupId: this.groupId, fromPoint: fromPoint})
}

TSMClient.prototype.setLastPoint = function (lastPoint) {
  this.lastPoint = lastPoint
}

module.exports = APIClient