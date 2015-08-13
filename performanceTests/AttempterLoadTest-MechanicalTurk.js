// invoke this test from the command line with:
// "node [filepath of this file] [number of attempts to test]"
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

// 1. POST HITs to the Mechanical Turk sandbox

var crypto = require('crypto');

var generateRequestSignature = function(params, secretAccessKey){
  var text = params.Service + params.Operation + params.Timestamp;
  var hmac = crypto
             .createHmac('sha1', secretAccessKey)
             .update(text)
             .digest('base64');
  return hmac;
}

var querystring = require("querystring");
var parseString = require('xml2js').parseString;

var fs = require("fs");

var questionForm = fs.readFileSync(
  "performanceTests/assets/QuestionForm.xml",
  "utf8");

var awsKey = process.env["AWS_ACCESSKEYID"];
var awsSecretKey = process.env["AWS_SECRETACCESSKEY"];

if (awsKey === undefined || awsSecretKey === undefined){
  throw new Error("You need to specify both an AWS key and an AWS secret key in the environment variables");
}

var sandboxUrl = "https://mechanicalturk.sandbox.amazonaws.com";
var productionUrl = "https://mechanicalturk.amazonaws.com";
var service = "AWSMechanicalTurkRequester";

// start our tests with a clean slate
var test1Promise = redis.del(pqKey)
// then ask MTurk sandbox to create an HITType for this test
.then(function(numberAdded){
  var parameters = {
    Service: service,
    Operation: "RegisterHITType",
    AWSAccessKeyId: awsKey,
    Version: "2014-08-15",
    Timestamp: (new Date()).toISOString(),
    Title: (new Date()).toISOString() + " test",
    Description: "Test description",
    "Reward.1.Amount": 0.00,
    "Reward.1.CurrencyCode": "USD",
    AssignmentDurationInSeconds: 3600,
    Keywords: "location,%20photograph,%20image,%20identification,%20opinion"
  };
  parameters.Signature = generateRequestSignature(parameters, awsSecretKey);
  var url = sandboxUrl + "?" + querystring.stringify(parameters);
  
  var promise = rp.post({
    url: url
  })
  
  return promise;
})
// get the new HITType out of the response
.then(function(response){
  var promise = new Promise(function(resolve, reject){
    parseString(response, function(err, js){
      if (err) {
        reject(err);
      }
      resolve(js);
    });
  });
  return promise;
})
// now use GetAccountBalance as a stand-in for an operation that would cost
// money
.then(function(js){
  var promise = new Promise(function(resolve, reject){
    var successfulAttempts = 0;
  
    var makeAttempt = function(id) {
      var HITTypeId = js.RegisterHITTypeResponse.RegisterHITTypeResult[0].HITTypeId;
      var parameters = {
        Service: service,
        AWSAccessKeyId: awsKey,
        Version: "2014-08-15",
        Operation: "GetAccountBalance",
        Timestamp: (new Date()).toISOString()
      };
      parameters.Signature = generateRequestSignature(parameters, awsSecretKey);
      var url = productionUrl + "?" + querystring.stringify(parameters);
      
      // request-promise's default behavior is to reject the promise if the
      // response code is anything other than 2XX
      var promise = rp.post({
        url: url
      })
      .then(function(response){
        // no need to log anything on success
        successfulAttempts++;
        return response;
        },
        function(response){
          console.log("request failed with response: " + response);
          return response;
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
      makeAttempt: makeAttempt,
      getPendingWorkUnits: function(){
        var promise = new Promise(function(resolve, reject){
          // member before score when interacting with the PQ directly
          var workUnits = [];
          for (var i = 0; i < testUnitCount; i++){
            // in redis-land, scores go first
            workUnits.push(i);
            workUnits.push(0); // 1970; should get popped immediately
          }
          resolve(workUnits);
        })
        return promise;
      }
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