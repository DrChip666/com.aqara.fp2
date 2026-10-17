'use strict';

// hap-controller loads this module inside a try/catch for its Bluetooth transport.
// Returning null makes it skip Bluetooth cleanly; the IP transport is unaffected.
module.exports = function nobleStub() {
  return null;
};
