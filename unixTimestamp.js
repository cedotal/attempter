var unixTimestamp = function(){
  return Date.now() / 1000 | 0;
}

module.exports = unixTimestamp;