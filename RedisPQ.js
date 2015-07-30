var Redis = require('ioredis');
var redis = new Redis(process.env.REDIS_URL);

var Promise = require('promise');

var unixTimestamp = require('./unixTimestamp');

// note that all calls to the RedisPQ's API return promises. RedisPQ does not
// catch errors; instead, the client is responsible for catching errors
// however they please.
var RedisPQ = function(key) {
  var self = this;
  
  var errorHandler = function(message){
    throw new Error(message);
  };
  
  // pops work off of the PQ using the following rules:
  // * only consider work schedule for earlier than the current unix second
  // * sort results ascending by the scheduled unix second on which they should
  //   be ordered
  //
  // the word "pop" does indeed imply that the returned units are removed from
  // the PQ.
  //
  // we only return overdue results (as opposed to including results that are
  // scheduled for the current second to avoid the following bug:
  // 1. popUpToThisMuchOverdueWork gets work scheduled for up to and including
  //    the current second S
  // 2. some other event adds a new work unit to the redis sorted set, scheduled
  //    for second S
  // 3. popUpToThisMuchOverdueWork deletes all the work for the current second
  //    S, thus wiping the work unit from the previous step without ever
  //    handling it
  this.popAllOverdueWork = function(){
    // you know what would be bad? if we called unixTimestamp() twice in
    // separate places, and that caused us to delete un-popped units.
    var timestamp = unixTimestamp();
    
    var zrangebyscorePromise = redis.zrangebyscore([key, 0, timestamp - 1], 'WITHSCORES');
    
    var zremrangebyscorePromise = zrangebyscorePromise
    // don't delete anything until we're done retreiving
    .then(function(results){
      return redis.zremrangebyscore(key, 0, timestamp - 1);
    });
    
    var combinedPromise = Promise.all([
      zrangebyscorePromise,
      zremrangebyscorePromise
    ])
    .then(function(values){
      // this function returns synchronously -- this extra then() is just a way
      // of discarding the value we don't care about
      //
      // since we called zrangebyscore with the "WITHSCORES" argument, we're
      // actually getting an array that alternates between members and their
      // scores. let's transform that array into an array of maps.
      var valuesAndScores = [];
      var even = false;
      values[0].forEach(function(value){
        if (even == false) {
          valuesAndScores.push({ value: value });
        } else {
          valuesAndScores[valuesAndScores.length - 1].scheduledTime = value;
        }
        even = !even;
      })
      return valuesAndScores;
    });
    
    return combinedPromise;
  }
  
  // add to the sorted set, using the provided score to sort
  this.add = function(id, score){
    // ioredis library functions return a promise
    return redis.zadd(key, score, id);
  };
  
  return {
    popAllOverdueWork: this.popAllOverdueWork,
    add: this.add
  };
};

module.exports = RedisPQ;