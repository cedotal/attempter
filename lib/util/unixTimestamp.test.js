var unixTimestamp = require('./unixTimestamp');

var assert = require('assert');

var ts = unixTimestamp();
assert.equal(!isNaN(Number(ts)), true);
assert.equal(ts > 0, true);