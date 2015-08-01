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

// clear our key before testing
redis.del(key1)
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
})
// throw any errors that occured along the chain
.catch(errorHandler);


// 2. test of add() and popAllOverdueWork() with real timestamps
var key2 = "testPQ2";
var redisPQ2 = new RedisPQ(key2);

// clear our key before testing
redis.del(key2)
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
  return redisPQ2.add(5, unixTimestamp() - 1e4)
})
.then(function(numberAdded){
  return redisPQ2.add(6, 100000000000000002)
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
})
// throw any errors that occured along the chain
.catch(errorHandler)
// and end our test suite!
.then(function(){
  console.log("all tests passed!");
  process.exit();
});