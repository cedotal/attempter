var assert = require('assert');

var RedisPQ = require('./RedisPQ');

// use our own redis client so we can create test conditions out-of-band from
// the PQ wrapper
var Redis = require('ioredis');
var redis = new Redis(process.env.REDIS_URL);

var unixTimestamp = require('./util/unixTimestamp');

var errorHandler = function(message){
  throw new Error(message.stack);
};

// 1. basic test of add() and popAllOverdueWork()
var key1 = "testPQ1";
var redisPQ1 = new RedisPQ(key1);

// store as a promise so we can run tests serially
//
// clear our key before testing
var test1Promise = redis.del(key1)
// make sure it's clearer
.then(function(numberRemoved){
  return redis.zcard(key1);
})
.then(function(cardinality){
  return assert.equal(cardinality, 0);
})
// put things on the PQ
.then(function(assertionResponse){
  return redisPQ1.add(2, 2)
})
.then(function(numberAdded){
  return redisPQ1.add(0, 0)
})
// intermediate size check
.then(function(numberAdded){
  return redis.zcard(key1);
})
.then(function(cardinality){
  return assert.equal(cardinality, 2);
})
// back to adding
.then(function(assertionResponse){
  return redisPQ1.add(1, 1)
})
// make sure they were all stored
.then(function(numberAdded){
  return redis.zcard(key1);
})
.then(function(cardinality){
  return assert.equal(cardinality, 3);
})
// ensure that popping pops all off
.then(function(assertionResponse){
  return redisPQ1.popAllOverdueWork();
})
// make sure they were all stored
.then(function(allOverdueWork){
  assert.equal(allOverdueWork.length, 3);
  assert.equal(allOverdueWork[0].value, 0);
  assert.equal(allOverdueWork[0].scheduledTime, 0);
  assert.equal(allOverdueWork[1].value, 1);
  assert.equal(allOverdueWork[1].scheduledTime, 1);
  assert.equal(allOverdueWork[2].value, 2);
  assert.equal(allOverdueWork[2].scheduledTime, 2);
  // just return something for Promise style's sake
  return undefined;
})
// leave our campsite clean by clearing out the key
.then(function(undefinedResponse){
  return redis.del(key1);
});

// 2. test of add() and popAllOverdueWork() with real timestamps
var key2 = "testPQ2";
var redisPQ2 = new RedisPQ(key2);

// clear our key before testing
var test2Promise = test1Promise
.then(function(finalTest1Response){
  redis.del(key2)
})
// make sure it's clearer
.then(function(numberRemoved){
  return redis.zcard(key2);
})
.then(function(cardinality){
  return assert.equal(cardinality, 0);
})
// intermix adding timestamps that are:
// * real, and definitely in the past
// * real, but in the far future
.then(function(assertionResponse){
  return redisPQ2.add(1, unixTimestamp() - 1e4)
})
.then(function(numberAdded){
  return redisPQ2.add(2, 100000000000000000)
})
.then(function(numberAdded){
  return redisPQ2.add(3, unixTimestamp() - 1e4)
})
.then(function(numberAdded){
  return redisPQ2.add(4, 100000000000000001)
})
.then(function(numberAdded){
  return redis.zcard(key2);
})
// make sure all were added
.then(function(cardinality){
  return assert.equal(cardinality, 4);
})
// test addMany
.then(function(assertionResponse){
  return redisPQ2.addMany([5, unixTimestamp() - 1e4, 6, 100000000000000002]);
})
// make sure they were all stored
.then(function(numberAdded){
  return redis.zcard(key2);
})
.then(function(cardinality){
  return assert.equal(cardinality, 6);
})
// ensure that popping pops only the ones from the past off
.then(function(assertionResponse){
  return redisPQ2.popAllOverdueWork();
})
// make sure they were all stored
.then(function(allOverdueWork){
  assert.equal(allOverdueWork.length, 3);
  assert.equal(allOverdueWork[0].value, 1);
  assert.equal(allOverdueWork[0].scheduledTime < unixTimestamp(), true);
  assert.equal(allOverdueWork[1].value, 3);
  assert.equal(allOverdueWork[1].scheduledTime < unixTimestamp(), true);
  assert.equal(allOverdueWork[2].value, 5);
  assert.equal(allOverdueWork[2].scheduledTime < unixTimestamp(), true);
  // just return something for Promise style's sake
  return undefined;
})
// make sure we still have 3
.then(function(undefinedResponse){
  return redis.zcard(key2);
})
.then(function(cardinality){
  return assert.equal(cardinality, 3);
})
// leave our campsite clean by clearing out the key
.then(function(assertionResponse){
  return redis.del(key2);
});

// 3. test object serialization
var key3 = "testPQ3";
var redisPQ3 = new RedisPQ(key3);

// clear our key before testing
var test3Promise = test2Promise
.then(function(finalTest2Response){
  redis.del(key3)
})
// make sure it's cleared
.then(function(numberRemoved){
  return redis.zcard(key3);
})
.then(function(cardinality){
  return assert.equal(cardinality, 0);
})
// try adding members that are:
// * numbers
// * strings
// * arrays
// * objects
.then(function(assertionResponse){
  return redisPQ3.add(15, 1);
})
.then(function(numberAdded){
  return redisPQ3.add("I know, you know, we believe in a land of love.", 2);
})
.then(function(numberAdded){
  return redisPQ3.add([
    "now that I'm grown I eat",
    5,
    "dozen eggs"
  ], 3);
})
.then(function(numberAdded){
  return redisPQ3.add({
    name: "Red Dwarf",
    designation: "mining ship",
    crew: 1
  }, 4);
})
.then(function(numberAdded){
  return redis.zcard(key3);
})
// make sure all were added
.then(function(cardinality){
  return assert.equal(cardinality, 4);
})
// ensure that popping pops only the ones from the past off
.then(function(assertionResponse){
  return redisPQ3.popAllOverdueWork();
})
// make sure they were all stored
.then(function(allOverdueWork){
  assert.equal(allOverdueWork.length, 4);
  // did we get back a number?
  assert.equal(typeof allOverdueWork[0].value, "number");
  assert.equal(allOverdueWork[0].value, 15);
  // did we get back a string?
  assert.equal(typeof allOverdueWork[1].value, "string");
  assert.equal(allOverdueWork[1].value, "I know, you know, we believe in a land of love.");
  // did we get back an array?
  assert.equal(typeof allOverdueWork[2].value, "object");
  assert.equal(allOverdueWork[2].value[0], "now that I'm grown I eat");
  assert.equal(typeof allOverdueWork[2].value[0], "string");
  assert.equal(allOverdueWork[2].value[1], 5);
  assert.equal(typeof allOverdueWork[2].value[1], "number");
  // did we getback an object?
  assert.equal(typeof allOverdueWork[3].value, "object");
  assert.equal(allOverdueWork[3].value.name, "Red Dwarf");
  assert.equal(typeof allOverdueWork[3].value.name, "string");
  assert.equal(allOverdueWork[3].value.designation, "mining ship");
  assert.equal(typeof allOverdueWork[3].value.designation, "string");
  assert.equal(allOverdueWork[3].value.crew, 1);
  assert.equal(typeof allOverdueWork[3].value.crew, "number");
  // just return something for Promise style's sake
  return undefined;
})
// make sure all were removed 
.then(function(undefinedResponse){
  return redis.zcard(key3);
})
.then(function(cardinality){
  return assert.equal(cardinality, 0);
})
// leave our campsite clean by clearing out the key
.then(function(assertionResponse){
  return redis.del(key3);
})
// throw any errors that occured along the chain
.catch(errorHandler)
// and end our test suite!
.then(function(){
  console.log("all tests passed!");
  process.exit();
});