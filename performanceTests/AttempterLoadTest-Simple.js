// invoke this test from the command line with:
// "node [filepath of this file] [number of attempts to test] [url to hit]"
var Attempter = require('../lib/Attempter');

var unixTimestamp = require('../lib/util/unixTimestamp');

var Redis = require('ioredis');
var redis = new Redis(process.env.REDIS_URL);

var rp = require('request-promise');

var Promise = require('promise');

var errorHandler = function(message){
  throw new Error(message.stack);
};

var namespace = 'attempterPerformanceTest';
var pqKey = namespace + '_pq';

var testUnitCount = process.argv[2] || 1000;

var testURL = process.argv[3] || "http://nytimes.com";

var zaddArgs = [pqKey];
for (var i = 0; i < testUnitCount; i++){
  // in redis-land, scores go first
  zaddArgs.push(0); // 1970; handle immediately
  zaddArgs.push(i);
}

// 1. make simple GET requests

// start our tests with a clean slate
var test1Promise = redis.del(pqKey)
// then add our test units
.then(function(numberDeleted){
  return redis.zadd(zaddArgs);
})
.then(function(numberAdded){
  var promise = new Promise(function(resolve, reject){
    var successfulAttempts = 0;
  
    var makeAttempt = function(id) {
      var promise = rp(testURL)
      .then(function(response){
        successfulAttempts++;
        return response;
        },
        function(message){
          return message;
        }
      );
      return promise;
    }
    
    var nextNotification = 0;
    
    var beginTime = unixTimestamp();
    
    var checkProgress = function(){
      if (successfulAttempts >= testUnitCount) {
        var endTime = unixTimestamp();
        console.log(testUnitCount + " successful attempts have been made.");
        console.log("average ms per request for all requests was: " + ((endTime - beginTime)/testUnitCount));
        resolve();
      } else {
        setImmediate(checkProgress);
        if (successfulAttempts >= nextNotification){
          nextNotification += testUnitCount/10;
          var nowTime = unixTimestamp();
          console.log(successfulAttempts + " successful attempts have been made");
          console.log("average ms per request so far is: " + ((nowTime - beginTime)/successfulAttempts));
        }
      }
    }
    
    setImmediate(checkProgress);
    
    var attempter = new Attempter({
      namespace: namespace,
      maxActiveAttempts: 480,
      makeAttempt: makeAttempt
    });
  });
  return promise;
})
// leave our campsite clean by clearing out the key
.then(function(assertionResponse){
  return redis.del(pqKey);
})
// throw any errors that occured along the chain
.catch(errorHandler)
// and end our test suite!
.then(function(){
  console.log("load test complete!");
  process.exit();
});