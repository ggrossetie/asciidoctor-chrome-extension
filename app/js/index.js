import { convert, fetchAndConvert } from './module/converter.js'

function getErrorInfo (error) {
  const errorInfo = {}
  if (typeof error === 'object') {
    Object.getOwnPropertyNames(error).forEach(function (key) {
      errorInfo[key] = error[key]
    }, error)
  } else {
    errorInfo.message = error
  }
  return errorInfo
}

const webExtension = typeof browser === 'undefined' ? chrome : browser
webExtension.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.action === 'fetch-convert') {
    fetchAndConvert(sender.tab.url, request.initial)
      .then(result => {
        if (result) {
          sendResponse(result)
        } else {
          sendResponse({})
        }
      })
      .catch((error) => sendResponse({ error: getErrorInfo(error) }))
    return true
  } else if (request.action === 'convert') {
    convert(sender.tab.url, request.source)
      .then(result => sendResponse(result))
      .catch((error) => sendResponse({ error: getErrorInfo(error) }))
    return true
  }
  // send an empty response to avoid the pesky error "The message port closed before a response was received"
  sendResponse({})
})
