// if this test file runs and completes, it passes. if it throws an exception
// or hangs forever, it passes.
//
// note that this test makes heavy use of Node.js' "setImmediate" method to
// "manipulate time." Even when logging to the console on each tick, though,
// Node ticks are so short that this test file should complete in under 15
// seconds. If it doesn't, something is wrong.
//
// Propagating errors through the Promise chain currently gives useless stack
// traces, but someone in the future can deal with that.

var Attempter = require('./Attempter');

var assert = require('assert');

var Promise = require('promise');

// use our own redis client so we can create test conditions out-of-band from
// the PQ wrapper
var Redis = require('ioredis');
var redis = new Redis(process.env.REDIS_URL);

var errorHandler = function(message){
  throw new Error(message.stack);
};

// a mock external service that models connectionless requests (a la HTTP).
// its interface allows toggling of:
// * accepting: when requests are returned, are they accepted or rejected
// * paused: whether requests are returned or held until paused becomes true

var MockService = function(){
  var self = this;
  this.accepting = true;
  this.paused = false
  
  this.openedRequestsCount = 0;
  this.acceptedRequestsCount = 0;
  this.rejectedRequestsCount = 0;
  
  // used to ensure we're not just ordering the same unit over and over
  this.requestBodyCountMap = {};
  
  this.makeRequest = function(body){
    self.openedRequestsCount++;
    if (self.requestBodyCountMap[body] === undefined) {
      self.requestBodyCountMap[body] = 1;
    } else {
      self.requestBodyCountMap[body]++;
    }
    var requestPromise = new Promise(function(resolve, reject){
      var checkRequests = function(){
        if (self.paused == false){
          if (self.accepting == true) {
            self.acceptedRequestsCount++;
            resolve("The request was accepted with body: " + body);
          } else {
            self.rejectedRequestsCount++;
            reject("This request was rejected for testing purposes with body: " + body);
          }
        } else {
          // if we're paused now, check for a paused state on the next event
          // loop
          setImmediate(checkRequests);
        }
      }
      checkRequests();
    });
    return requestPromise;
  };
}

////////////////////////////////////////////////////////////////////////////////
///                                                                          ///
/// 1a. Does it do work?                                                     ///
/// 1b. Does it pick up new work once slots under the concurrency limit have ///
///    been freed up?                                                        ///
///                                                                          ///
////////////////////////////////////////////////////////////////////////////////

// an attempter has a namespace that may contain multiple redis keys
var attempterNamespace1 = "testNamespace1",
    pqKey1 = attempterNamespace1 + "_pq";

// ordering exactly one more unit or work than the concurrency limit allows
// us to prove that active attempt slots are indeed relinquished once an
// attempt is successful
var numberOfWorkUnitsToTest1 = 5;
var concurrencyLimit1 = numberOfWorkUnitsToTest1 - 1;

// store as a Promise so we can delay the second test until the first one is
// complete
//
// also, start with a clean key
var test1Promise = redis.del(pqKey1)
// manually insert more than the concurrency limit # of work units into redis
.then(function(numberDeleted){
  console.log("Begin test 1");
  var redisArgs = [pqKey1];
  for (var i = 0; i < numberOfWorkUnitsToTest1; i++){
    // in redis-land, scores go first
    redisArgs.push(0); // timestamp in 1970; should get popped immediately
    redisArgs.push(i);
  }
  return redis.zadd(redisArgs);
})
// make sure they were all stored, and make sure in two different ways
.then(function(numberAdded){
  return assert.equal(numberAdded, numberOfWorkUnitsToTest1);
})
.then(function(assertionResponse){
  return redis.zcard(pqKey1);
})
.then(function(cardinality){
  return assert.equal(cardinality, numberOfWorkUnitsToTest1);
})
// now init an Attempter and make sure it orders work
.then(function(assertionResponse){
  var attempterTestPromise = new Promise(function(resolve, reject){
    var mockService = new MockService();
    mockService.accepting = true;
    mockService.paused = false;
    
    // a function that constantly sees how many requests have been processed,
    // logs progress, and resolves this Promise when the expected amount of work
    // has been done
    var nextNotificationThreshold = 0;
    var checkProgress = function(){
      if (mockService.acceptedRequestsCount >= nextNotificationThreshold) {
        console.log(nextNotificationThreshold + " requests accepted");
        nextNotificationThreshold += 1;
      }
      if (mockService.acceptedRequestsCount === numberOfWorkUnitsToTest1) {
        // resolve promise
        console.log("The attempter indeed handled all the work it was supposed to.")
        resolve();
      } else {
        // else continue
        setImmediate(checkProgress);
      }
    }
    
    // check progress until this promise resolves
    checkProgress();
    
    // now actually create the attempter, which will cause checkProgress above
    // to start picking up meaningful events
    var attempter1 = new Attempter({
      namespace: attempterNamespace1,
      maxActiveAttempts: concurrencyLimit1,
      makeAttempt: function(unitId){
        return mockService.makeRequest(unitId);
      }
    });
  })
  return attempterTestPromise;
})
// throw any errors that occured along the chain
.catch(errorHandler)
// leave our campsite clean by clearing out the key
.then(function(assertionResponse){
  console.log("End test 1");
  return redis.del(pqKey1);
});

/////////////////////////////////////////////////
///                                           ///
/// 2. Does it observe the concurrency limit? ///
///                                           ///
/////////////////////////////////////////////////

// an attempter has a namespace that may contain multiple redis keys
var attempterNamespace2 = "testNamespace2",
    pqKey2 = attempterNamespace2 + "_pq";

// ordering exactly the concurrency limit's worth of work allows us to prove
// that the attempter stops ordering work after the last one
var numberOfWorkUnitsToTest2 = 5;
var concurrencyLimit2 = numberOfWorkUnitsToTest2 - 1;

// picking up where we left off
var test2Promise = test1Promise
// start with a clean key
.then(function(finalTest1Response){
  console.log("Begin test 2");
  redis.del(pqKey2);
})
// manually insert more than the concurrency limit # of work units into redis
.then(function(assertionResponse){
  var redisArgs = [pqKey2];
  for (var i = 0; i < numberOfWorkUnitsToTest2; i++){
    // in redis-land, scores go first
    redisArgs.push(0); // timestamp in 1970; should get popped immediately
    redisArgs.push(i);
  }
  return redis.zadd(redisArgs);
})
// now init an Attempter and make sure it orders work
.then(function(numberAdded){
  var attempterTestPromise = new Promise(function(resolve, reject){
    var mockService = new MockService();
    mockService.accepting = true;
    // make sure it's paused, so we can ensure the final work unit is not being
    // handled
    mockService.paused = true;
    
    // now actually create the attempter
    var attempter2 = new Attempter({
      namespace: attempterNamespace2,
      maxActiveAttempts: concurrencyLimit2,
      makeAttempt: function(unitId){
        return mockService.makeRequest(unitId);
      }
    });
    
    // a function that constantly sees how many requests have been processed,
    // logs progress, and if the concurrency limit's worth of requests have been
    // made, make sure the attempter is no longer trying to process more work
    var nextNotificationThreshold = 0;
    var checkProgress = function(){
      if (mockService.openedRequestsCount >= nextNotificationThreshold) {
        console.log(nextNotificationThreshold + " requests opened");
        nextNotificationThreshold += 1;
      }
      if (mockService.openedRequestsCount === concurrencyLimit2) {
        if (attempter2.maxActiveAttemptsReached() === true){
          console.log("The attempter indeed stopped accepting new requests.");
          resolve("The attempter indeed stopped accepting new requests.");
        } else {
          reject("The attempter is continuing to accept new requests.");
        }
      } else {
        // else continue
        setImmediate(checkProgress);
      }
    }
    // check progress until this promise resolves
    checkProgress();
  })
  return attempterTestPromise;
})
// throw any errors that occured along the chain
.catch(errorHandler)
// leave our campsite clean by clearing out the key
.then(function(undefinedErrorHandlerResponse){
  console.log("End test 2");
  return redis.del(pqKey2);
});

////////////////////////////////////
///                              ///
/// 3. Does it retry on failure? ///
///                              ///
////////////////////////////////////

// an attempter has a namespace that may contain multiple redis keys, 
var attempterNamespace3 = "testNamespace3",
    pqKey3 = attempterNamespace3 + "_pq";

var numberOfWorkUnitsToTest3 = 5;
var concurrencyLimit3 = numberOfWorkUnitsToTest3;

// start where we left off
var test3Promise = test2Promise
// start with a clean key
.then(function(finalTest1Response){
  console.log("Begin test 3");
  redis.del(pqKey3);
})
// manually insert more than the concurrency limit # of work units into redis
.then(function(assertionResponse){
  var redisArgs = [pqKey3];
  for (var i = 0; i < numberOfWorkUnitsToTest3; i++){
    // in redis-land, scores go first
    redisArgs.push(0); // timestamp in 1970; should get popped immediately
    redisArgs.push(i);
  }
  return redis.zadd(redisArgs);
})
// now init an Attempter and make sure it re-orders work
.then(function(numberAdded){
  var attempterTestPromise = new Promise(function(resolve, reject){
    var mockService = new MockService();
    // respond to all requests, but respond with a rejection
    mockService.accepting = false;
    mockService.paused = false;
    
    // now actually create the attempter
    var attempter3 = new Attempter({
      namespace: attempterNamespace3,
      maxActiveAttempts: concurrencyLimit3,
      makeAttempt: function(unitId){
        return mockService.makeRequest(unitId);
      },
      retryDelay: 2000 // ms; short to make the test run faster
    });
    
    // a function that constantly sees how many requests have been opened,
    // logs progress, and makes sure that:
    // 1. we eventually order double the number that we intended
    // 2. we're actually re-ordering each individual work unit, not just
    // re-ordering one unit many times
    var nextNotificationThreshold = 0;
    var checkProgress = function(){
      if (mockService.openedRequestsCount >= nextNotificationThreshold) {
        console.log(nextNotificationThreshold + " requests opened");
        nextNotificationThreshold += 1;
      }
      if (mockService.openedRequestsCount === numberOfWorkUnitsToTest3*2) {
        var underOrderingDetected = false;
        console.log("Number of opened requests by body content:");
        console.log(mockService.requestBodyCountMap);
        console.log("All units expected to be retried were retried.")
        for (var i = 0; i < numberOfWorkUnitsToTest3; i++){
          if (mockService.requestBodyCountMap[i] < 2) {
            underOrderingDetected = true;
          }
        }
        if (underOrderingDetected === false){
          // pause mockService so we don't get annoying messages on subsequent
          // tests
          mockService.paused = true;
          resolve("The attempter ordered everything at least twice.");
        } else {
          // pause mockService so we don't get annoying messages on subsequent
          // tests
          mockService.paused = true;
          reject("The attempter failed to order everything at least twice.");
        }
      } else {
        // else continue
        setImmediate(checkProgress);
      }
    }
    // check progress until this promise resolves
    checkProgress();
  })
  return attempterTestPromise;
})
// throw any errors that occurred along the chain
.catch(errorHandler)
// leave our campsite clean by clearing out the key
.then(function(undefinedErrorHandlerResponse){
  console.log("End test 3");
  return redis.del(pqKey3);
});

/////////////////////////////////////////////////////////////////////////////
///                                                                       ///
/// 4. Does it avoid ordering work actually scheduled for the far future? ///
///                                                                       ///
/////////////////////////////////////////////////////////////////////////////

// an attempter has a namespace that may contain multiple redis keys
var attempterNamespace4 = "testNamespace4",
    pqKey4 = attempterNamespace4 + "_pq";

// ordering exactly one more unit of work than the concurrency limit allows
// us to prove that active attempt slots are indeed relinquished once an
// attempt is successful
var numberOfWorkUnitsToTest4 = 10;
// just enough to make sure the concurrency limit doesn't get in the way
var concurrencyLimit4 = numberOfWorkUnitsToTest4 + 1;

// pick up where we left off
var test4Promise = test3Promise
// start with a clean key
.then(function(finalTest3Response){
  redis.del(pqKey4);
})
// manually insert some units in the past and some units in the future
.then(function(numberDeleted){
  console.log("Begin test 4");
  var redisArgs = [pqKey4];
  for (var i = 0; i < (numberOfWorkUnitsToTest4/2); i++){
    // in redis-land, scores go first
    redisArgs.push(0); // timestamp in 1970; should get popped immediately
    // past has negative values for testing purposes below
    redisArgs.push((-1)*(i + 1));
  }
  for (var i = 0; i < (numberOfWorkUnitsToTest4/2); i++){
    // in redis-land, scores go first
    redisArgs.push(16751491200000); // timestamp in 2500; should never get popped
    // future has positive values for testing purposes below
    redisArgs.push(i + 1);
  }
  return redis.zadd(redisArgs);
})
// make sure they were all stored, and make sure in two different ways
.then(function(numberAdded){
  return assert.equal(numberAdded, numberOfWorkUnitsToTest4);
})
.then(function(assertionResponse){
  return redis.zcard(pqKey4);
})
.then(function(cardinality){
  return assert.equal(cardinality, numberOfWorkUnitsToTest4);
})
// now init an Attempter and make sure it only orders the ones we want it to order
.then(function(assertionResponse){
  var attempterTestPromise = new Promise(function(resolve, reject){
    var mockService = new MockService();
    mockService.accepting = true;
    mockService.paused = false;
    
    // we perform two checks:
    // 1. a check that cycles initially, then stops once it detects that the
    //    expected number of requests have been opened on the MockService. once
    //    this is detected, we stop this cycle and begin cycling #2.
    // 2. a check that waits a number of program ticks equal to the difference
    //    between the number of units we would expect to order and the total
    //    number of units inserted. by the time this number of ticks is past,
    //    all of the units we don't intended to order would have been ordered
    //    if the attempter is ignoring the "only order units in the past" rule.
    
    // define first because it's invoked below
    var tickCount = 0;
    var finalCheck = function(){
      if (tickCount > (numberOfWorkUnitsToTest4/2)) {
        console.log(mockService.openedRequestsCount);
        console.log(numberOfWorkUnitsToTest4/2);
        if (mockService.openedRequestsCount === (numberOfWorkUnitsToTest4/2)) {
          // there's actually one more check: we should make sure that the past
          // units were ordered, not the future ones
          //
          // remember, past units have value 0 and future units have value 1
          var futureDetected = false;
          for (var key in mockService.requestBodyCountMap) {
            if (key > 0) {
              futureDetected = true;
            }
          }
          if (futureDetected === true){
            reject("The attempter appears to have ordered units scheduled for the future.");
          } else {
            console.log("All ordered units were indeed scheduled for the past.")
            resolve("The attempter only ordered the units in the past.");
          }
        } else {
          // fail!
          reject("The attempter appears to have ordered units scheduled for the future.");
        }
      } else {
        tickCount++;
        setImmediate(finalCheck);
      }
    }
    
    var nextNotificationThreshold = 0;
    var initialCheck = function(){
      if (mockService.acceptedRequestsCount >= nextNotificationThreshold) {
        console.log(nextNotificationThreshold + " requests accepted");
        nextNotificationThreshold += 1;
      }
      if (mockService.acceptedRequestsCount === numberOfWorkUnitsToTest4/2) {
        setImmediate(finalCheck);
      } else {
        // else continue
        setImmediate(initialCheck);
      }
    }
    
    // begin checking progress
    initialCheck();
    
    // now actually create the attempter, which will cause checkProgress above
    // to start picking up meaningful events
    var attempter4 = new Attempter({
      namespace: attempterNamespace4,
      maxActiveAttempts: concurrencyLimit4,
      makeAttempt: function(unitId){
        return mockService.makeRequest(unitId);
      }
    });
  })
  return attempterTestPromise;
})
// throw any errors that occured along the chain
.catch(errorHandler)
// leave our campsite clean by clearing out the key
.then(function(assertionResponse){
  console.log("End test 4");
  redis.del(pqKey4);
  process.exit();
});