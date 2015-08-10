var RedisPQ = require('./RedisPQ');
var JavaScriptPQ = require('js-priority-queue');

var unixTimestamp = require('./util/unixTimestamp');

var Attempter = function(args){
  var self = this;
  
  // argument validation
  if (typeof args.namespace !== "string" || args.namespace === "") {
    throw new Error("Attempter \"namespace\" argument must be a string");
  }
  
  if (typeof args.makeAttempt !== "function") {
    throw new Error("Attempter \"makeAttempt\" argument must be a function");
  }
  
  if (args.maxActiveAttempts !== undefined && isNaN(Number(args.maxActiveAttempts))) {
    throw new Error("Attempter \"maxActiveAttempts\" argument, if provided, must be a Number");
  }
  
  if (args.retryDelay !== undefined && isNaN(Number(args.retryDelay))) {
    throw new Error("Attempter \"retryDelay\" argument, if provided, must be a Number");
  }
  
  // set up active attempt counters
  this.activeAttempts = 0;
  this.maxActiveAttempts = args.maxActiveAttempts || 480;
  
  // retry delay defaults to 10 seconds, measured in ms
  this.retryDelay = args.retryDelay || 10000;
  
  // set up an in-process PQ. this will allow us to store work units locally,
  // which we'll need to do because we're getting many from Redis at once.
  // 
  // this PQ will have to store maps containing both priority and value, since
  // the PQ library performins its sorting on unitary objects.
  //
  // as always for our Attempter services, priorities (aka "scores" in Redis)
  // are Unix timestamps (to the millisecond). earlier timestamps
  // get processed first.
  this.jsPQ = new JavaScriptPQ({
    comparator: function(a,b){
      return a.scheduledTime - b.scheduledTime
    }
  });
  
  // store args
  this.makeAttempt = args.makeAttempt;
  this.namespace = args.namespace;
  
  // we use multiple redis keys, so we'll append suffixes to our Attempter's
  // namespace to keep track of them all
  this.redisPQ = new RedisPQ(self.namespace + "_pq");
  
  // rejectionHandler for Promise chains
  var errorHandler = function(message){
    throw new Error(message.stack);
  };
  
  // on every tick, we're either waiting on a request to Redis for work that
  // needs processing, or we're initiating a request
  var orderWorkFromRedis = function() {
    // popUpToThisMuchOverdueWork is documented in the RedisPQ module. its
    // exact behavior is a bit complex, so check there if you need info.
    //
    // maybe in the future we'll add a limit, since I'm not sure how the
    // networking stack would deal with having millions of members and their
    // scores being sent over the wire.
    self.redisPQ.popAllOverdueWork()
    .then(
      function(workUnits){ // success handler
        if (workUnits.length > 0) console.log("Attempter in namespace " + self.namespace + " is beginning to queue work units...");
        workUnits.forEach(function(workUnit){
          self.jsPQ.queue(workUnit);
        })
        if (workUnits.length > 0) console.log("Attempter in namespace " + self.namespace + " is done to queueing work units.");
        // fetch work forever
        setImmediate(orderWorkFromRedis);
      }, function(message) { // failure handler
        console.log("Attempter in namespace " + self.namespace + " failed to fetch work from PQ, with message:");
        console.log(message);
        // even on failure, keep trying to fetch work forever
        setImmediate(orderWorkFromRedis);
      }
    );
  };
  // start the forever loop
  orderWorkFromRedis();
  
  // making this function (or one like it) public is a pre-requisite for running
  // tests that ensure the Attempter is throttling properly
  this.maxActiveAttemptsReached = function(){
    return self.activeAttempts >= self.maxActiveAttempts;
  }
  
  // on every tick, we're also making attempts, if we have any work waiting
  // around in our in-process PQ
  //
  // when releasing active attempts, remember that requests to redis take up
  // a network connection, and thus any redis-dependent cleanup after a failed
  // request should continue to count against the concurrency limit until it's
  // done.
  var handleAttempt = function(){
    if ((self.jsPQ.length > 0) && (self.maxActiveAttemptsReached() == false)) {
      self.activeAttempts++;
      var workUnit = self.jsPQ.dequeue();
      self.makeAttempt(workUnit.value)
      .then(function(attemptResponse){ // success handler
        // reclaim active attempt slot
        self.activeAttempts--;
      },
      function(rejectionResponse){ // failure handler
        console.log("Attempter in namespace " + self.namespace + " failed makeAttempt, with message:");
        console.log(rejectionResponse);
        // if it fails for any reason, re-enqueue
        self.redisPQ.add(workUnit.value, unixTimestamp() + self.retryDelay)
        .then(function(message){ // success handler
          self.activeAttempts--;
        },
        function(message){ // failure handler
          console.log("Attempter in namespace " + self.namespace + " failed to re-enqueue, with message:");
          console.log(message);
          self.activeAttempts--;
        });
      })
    }
    setImmediate(handleAttempt);
  }
  // start the forever loop
  handleAttempt();
};

module.exports = Attempter;