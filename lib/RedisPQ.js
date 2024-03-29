var Redis = require('ioredis');
var redis = new Redis(process.env.REDIS_URL);

var Promise = require('promise');

var unixTimestamp = require('./util/unixTimestamp');

// note that all calls to the RedisPQ's API return promises. RedisPQ does not
// catch errors; instead, the client is responsible for catching errors
// however they please.
var RedisPQ = function(key) {
  var self = this;
  
  var errorHandler = function(message){
    throw new Error(message);
  };
  
  // pops work off of the PQ using the following rules:
  // * only consider work scheduled for earlier than the current unix
  //   millisecond
  // * sort results ascending by the scheduled unix ms on which they should
  //   be ordered
  //
  // the word "pop" does indeed imply that the returned units are removed from
  // the PQ.
  //
  // we only return overdue results (as opposed to including results that are
  // scheduled for the current second) to avoid the following bug:
  // 1. popUpToThisMuchOverdueWork gets work scheduled for up to and including
  //    the current millisecond S
  // 2. some other event adds a new work unit to the redis sorted set, scheduled
  //    for millisecond S
  // 3. popUpToThisMuchOverdueWork deletes all the work for the current ms
  //    S, thus wiping the work unit from the previous step without ever
  //    handling it
  this.popAllOverdueWork = function(){
    // you know what would be bad? if we called unixTimestamp() twice in
    // separate places, and a difference between the two caused us to delete
    // un-popped units.
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
          // coerce value types
          //
          // objects
          try {
            value = JSON.parse(value);
          } catch (e) {
            // oh, well, guess it wasn't originally an object!
          }
          
          // try numbers
          if (typeof value !== "object" && (isNaN(Number(value) === false))){
            value = Number(value);
          }
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
    // if we're dealing with an object, serialize it
    if (typeof id === "object") {
      id = JSON.stringify(id);
    }
    // ioredis library functions return a promise
    return redis.zadd(key, score, id);
  };
  
  // add to the sorted set, in format [member, score, member, score...]
  //
  // note that members will be converted to JSON if they are objects, otherwise,
  // they'll be stored as strings
  this.addMany = function(membersAndScores){
    // flip number and score positions b/c redis expects score before member
    //
    // remember that when 0-indexing, the first is even
    var scoresAndMembers = membersAndScores.map(function(value, index){
      if ((index % 2) === 0){ // even, is a member
        return membersAndScores[index + 1];
      } else { // odd, is a score
        var member = membersAndScores[index - 1];
        // if it's an object, serialize it
        return typeof member === "object" ? JSON.stringify(member) : member;
      }
    })
    return redis.zadd([key].concat(scoresAndMembers));
  }
  
  // remove everything from the sorted set
  this.clear = function(){
    return redis.del(key);
  }
  
  return {
    popAllOverdueWork: this.popAllOverdueWork,
    add: this.add,
    addMany: this.addMany,
    clear: this.clear
  };
};

module.exports = RedisPQ;