var redisPQ = require('./RedisPQ');
var JavaScriptPQ = require('js-priority-queue');

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
  
  // set up active attempt counters
  this.activeAttempter = 0;
  this.maxActiveAttempts = args.maxActiveAttempts || 480;
  
  // set up an in-process PQ. this will allow us to store work units locally,
  // which we'll need to do because we're getting many from Redis at once.
  // 
  // this PQ will have to store maps containing both priority and value, since
  // the PQ library performins its sorting on unitary objects.
  //
  // as always for our Attempter services, priorities (aka "scores" in Redis)
  // are Unix timestamps (to the second, not millisecond). earlier timestamps
  // get processed first.
  this.jsPQ = new JavaScriptPQ({
    comparator: function(a,b){
      return a.scheduledTime - b.scheduledTime
    }
  });
  
  // store args
  this.makeAttempt = args.makeAttempt;
  this.namespace = args.namespace;
  
  // rejectionHandler for Promise chains
  var errorHandler = function(message){
    throw new Error(message);
  };
  
  // on every tick, we're either waiting on a request to Redis for work that
  // needs processing, or we're initiating a request
  var orderWorkFromRedis = function() {
    // popUpToThisMuchOverdueWork is documented in the RedisPQ module. it's
    // exact behavior is a bit complex, so check there if you need info.
    //
    // maybe in the future we'll add a limit, since I'm not sure how the
    // networking stack would deal with having millions of members and their
    // scores being sent over the wire.
    redisPQ.popAllOverdueWork()
    // "You made me...Promises, Promises!" --Naked Eyes, 1983
    .then(
      function(workUnits){ // success handler
        workUnits.forEach(function(workUnit){
          self.jsPQ.queue(workUnit);
        })
        // fetch work forever
        process.nextTick(self.orderWorkFromRedis);
      }, function(message) { // failure handler
        console.log(message);
        // even on failure, keep trying to fetch work forever
        process.nextTick(self.orderWorkFromRedis);
      }
    );
  };
  // start the forever loop
  orderWorkFromRedis();
  
  // on every tick, we're also making attempts, if we have any work waiting
  // around in our in-process PQ
  var handleAttempt = function(){
    if (self.jsPQ.length > 0) {
      var workUnit = self.jsPQ.dequeue();
      self.makeAttempt(workUnit.value);
    }
    process.nextTick(self.handleAttempt);
  }
  // start the forever loop
  handleAttempt();
};