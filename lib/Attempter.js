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
  
  if (typeof args.makeAttempt !== "function") {
    throw new Error("Attempter \"makeAttempt\" argument must be a function");
  }
  
  if (typeof args.getPendingWorkUnits !== "function") {
    throw new Error("Attempter \"getPendingWorkUnits\" argument must be a function");
  }
  
  if (args.maxActiveAttempts !== undefined && isNaN(Number(args.maxActiveAttempts))) {
    throw new Error("Attempter \"maxActiveAttempts\" argument, if provided, must be a Number");
  }
  
  if (args.retryDelay !== undefined && isNaN(Number(args.retryDelay))) {
    throw new Error("Attempter \"retryDelay\" argument, if provided, must be a Number");
  }
  
  if (args.reconciliationInterval !== undefined && isNaN(Number(args.reconciliationInterval))) {
    throw new Error("Attempter \"reconciliationInterval\" argument, if provided, must be a Number");
  }
  
  // set up active attempt counters
  this.activeAttempts = 0;
  this.maxActiveAttempts = args.maxActiveAttempts || 480;
  
  // retry delay defaults to 10 seconds, measured in ms
  this.retryDelay = args.retryDelay || 10 * 1000;
  
  // reconciliation interval defaults to 10 minutes, measured in ms
  this.reconciliationInterval = args.reconciliationInterval || 10 * 60 * 1000;
  
  // set time of first reconciliation attempt
  this.nextReconciliationAttempt = unixTimestamp() + this.reconciliationInterval;
  
  // a flag that allows us to stop making new attempts and stop pulling work off
  // of the redis PQ, so all current attempts can finish and we can eventually
  // attempt to reconcile
  //
  // we begin with a reconciliation attempt
  this.tryingToReconcile = true;
  
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
  this.getPendingWorkUnits = args.getPendingWorkUnits;
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
    // popAllOverdueWork is documented in the RedisPQ module. its
    // exact behavior is a bit complex, so check there if you need info.
    //
    // maybe in the future we'll add a limit, since I'm not sure how the
    // networking stack/host OS memory would deal with having millions of
    // members and their scores being sent around at once.
    //
    // if we're currently trying to reconcile, wait until that's over
    if (self.tryingToReconcile === true) {
      setImmediate(orderWorkFromRedis);
    } else { // try to get work
      self.redisPQ.popAllOverdueWork()
      .then(
        function(workUnits){ // success handler
          if (workUnits.length > 0) console.log("Attempter in namespace " + self.namespace + " is beginning to queue work units...");
          workUnits.forEach(function(workUnit){
            self.jsPQ.queue(workUnit);
          })
          if (workUnits.length > 0) console.log("Attempter in namespace " + self.namespace + " is done queueing work units.");
          // fetch work forever
          setImmediate(orderWorkFromRedis);
        }, function(message) { // failure handler
          console.log("Attempter in namespace " + self.namespace + " failed to fetch work from PQ, with message: " + message);
          // even on failure, keep trying to fetch work forever
          setImmediate(orderWorkFromRedis);
        }
      );
    }
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
        console.log("Attempter in namespace " + self.namespace + " failed makeAttempt, with message: " + rejectionResponse);
        // if it fails for any reason, re-enqueue
        self.redisPQ.add(workUnit.value, unixTimestamp() + self.retryDelay)
        .then(function(message){ // success handler
          self.activeAttempts--;
        },
        function(message){ // failure handler
          console.log("Attempter in namespace " + self.namespace + " failed to re-enqueue, with message: " + message);
          self.activeAttempts--;
        });
      })
    }
    // now that we've handled the attempt, see if we need to reconcile
    if (self.tryingToReconcile === false) {
      if (unixTimestamp() > self.nextReconciliationAttempt){
        self.nextReconciliationAttempt = unixTimestamp() + self.reconciliationInterval;
        console.log("Attempter in namespace " + self.namespace + " beginning reconciliation.");
        self.tryingToReconcile = true;
        setImmediate(awaitReconciliation);
      } else {
        // go back to handling
        setImmediate(handleAttempt);
      }
    }
  }
  
  // wait until all attempts have completed, then start reconciliation
  var awaitReconciliation = function(){
    if (self.activeAttempts === 0) {
      performReconciliation();
    } else {
      setImmediate(awaitReconciliation);
    }
  }
  
  // actually perform reconciliation
  //
  // note that this does not loop with setImmediate; when everything it needs
  // to do is done, it just does it
  var performReconciliation = function(){
    // the various steps of reconciliation all need to be retried if they fail.
    // so we structure the reconciliation chain as a series of promises that
    // re-invoke the current step on failure.
    //
    // the below strategy does indeed pile up on the stack as we retry more and
    // more times, but if reconciliation is overflowing the stack then we have
    // much bigger problems in the realm of service availability.
    
    // 1. clear the queue
    var clearQueue = function(){
      self.redisPQ.clear()
      .then(function(numberRemoved){ // success handler
        getUnits();
      },
      function(message){ // failure handler
        // retry
        clearQueue();
      })
    }
    
    // 2. get pending work units
    var getUnits = function(){
      self.getPendingWorkUnits()
      .then(function(workUnits){ // success handler
        addToPQ(workUnits);
      },
      function(message){ // failure handler
        // retry
        getUnits();
      })
    }
    
    // 3. insert these work units into the pq
    var addToPQ = function(workUnits){
      self.redisPQ.addMany(workUnits)
      .then(function(numberRemoved){ // success handler
        // hey, we're not reconciling anymore!
        self.tryingToReconcile = false;
        // now, back to your regularly scheduled processing
        console.log("Attempter in namespace " + self.namespace + " done with reconciliation.");
        setImmediate(handleAttempt);
      },
      function(message){ // failure handler
        // retry
        addToPQ(workUnits);
      })
    }
    
    // now begin reconciling
    clearQueue();
  }
  
  // begin with a reconciliation
  //
  // activeAttempts should be 0 at startup, so this should go directly into
  // performReconciliation
  awaitReconciliation();
};

module.exports = Attempter;