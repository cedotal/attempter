var Attempter = require('./Attempter');

var assert = require('assert');

// use our own redis client so we can create test conditions out-of-band from
// the PQ wrapper
var Redis = require('ioredis');
var redis = new Redis(process.env.REDIS_URL);

var errorHandler = function(message){
  throw new Error(message);
};

///////////////////////////
///                     ///
/// 1. Does it do work? ///
///                     ///
///////////////////////////

var namespace1 = "testNamespace1";

// first arg is key name
var zaddArgs = [namespace1];

for (var i = 0; i < 100000; i++){
  var pastTimestamp = 0;
  // in redis-land, score argument goes before member argument
  zaddArgs.push(pastTimestamp);
  zaddArgs.push(i);
}

redis.del(namespace1)
.then(function(numberOfKeysDeleted){
  return redis.zadd(zaddArgs);
})
// make sure they were all stored, and make sure in two different ways
.then(function(numberAdded){
  return assert.equal(numberAdded, 100000);
})
.then(function(assertionResponse){
  return redis.zcard(namespace1);
})
.then(function(cardinality){
  return assert.equal(cardinality, 100000);
})
// now init an Attempter and make sure it won't go over its connection limit,
// even when there are more work units available in its internal queue
.then(function(assertionResponse){
  var attempter1 = new Attempter({
    namespace: namespace1,
    maxActiveAttempts: 5000,
    makeAttempt: function(unitId){
      
    }
  });
})
// throw any errors that occured along the chain
.catch(errorHandler)
// leave our campsite clean by clearing out the key
.then(function(assertionResponse){
  return redis.del(namespace1);
})
// and end our test suite!
.then(function(numberDeleted){
  console.log("all tests passed!");
  process.exit();
});

/////////////////////////////////////////////////
///                                           ///
/// 2. Does it observe the concurrency limit? ///
///                                           ///
/////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///                                                                         ///
/// 3. Does it pick up new work once slots under the concurrency limit have ///
///    been freed up?                                                       ///
///                                                                         ///
///////////////////////////////////////////////////////////////////////////////

////////////////////////////////////
///                              ///
/// 4. Does it retry on failure? ///
///                              ///
////////////////////////////////////

/*

var checkConsumption = function(){
  process.nextTick(checkConsumuption);
}
checkConsumption();

*/