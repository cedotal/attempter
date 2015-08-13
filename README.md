Attempter
============

Attempter is a module that attempts to perform actions of a similar type and,
upon failure, retries them.

What attempter is for
---------------

Attempter is designed to handle system actions that:
* Are initially requested from a process that needs to remain responsive
 * For instance, a web-facing process receives a request to perform a
   long-running background task
* In terms of running time, primarily consist of waiting on I/O
* Can fail without compromising the correctness of the entire program
 * Yes, there's an almost complete overlap between that and tasks that are
   I/O-bound
* Are subject to concurrency limits
 * For example: "no more than N attempts are permitted at once, because each
   attempt consumes a network connection and the host OS is limited to N
   simultaneous network connections"
* Should be attempted immediately upon request, and then retried periodically
  forever in case of failure

Using Attempter
---------------

An instance of Attempter is created with the following arguments:
* **namespace (String, required)**: a namespace to use for the Attempter's
  underlying Redis keys. Note that this is a nameSPACE, because an Attempter
  uses multiple keys for different purposes.
* **makeAttempt (function, required)**: makeAttempt, when passed a set member from
  Redis, attempts to do one unit of work. Note that this function MUST return
  a Promise that resolves if the attempt was successful and rejects if the
  attempts was unsuccessful. If it doesn't, unexpected program behavior will
  occur.
 * Note that makeAttempt is responsible for queueing up any successor events
   once it's created. For example, if a group of child objects need to be
   created after a parent object, makeAttempt must queue up the creation of the
   child objects after the parent object is created.
* **getPendingWorkUnits (function, required)**: Goes to the underlying source of
truth for work units and their state (usually an on-disk datbase) and returns a
promise that resolves with a value equal to an array of format [member, score,
member, score...] containing work units to be processed and their scores. The
Attempter, on receiving these
 * Note that getPendingWorkUnits runs immediately when an Attempter is
 initialized, and then periodically as dictated by the reconciliationInterval
 option.
* **maxActiveAttempts (Number, not required)**: A concurrency limiter. Note that
  the process of loading units from the work queue requires a single network
  connection, so take that into account when you pass a value here. Defaults
  to 480.
* **retryDelay (Number, not required)**: In milliseconds. Defaults to 10000 (10
seconds).
* **reconciliationInterval (Number, not required)**: In milliseconds. Defaults
to 600000 (10 minutes).


An instance of attempter does the following once created:
* Clears its underlying Redis PQ
* Fills its underlying Redis PQ with work units using getPendingWorkUnits
* Constantly attempts to load work into itself from a Redis-backed priority
  queue
* Attempts to handle as many loaded units as it is allowed to concurrently,
  using makeAttempt for each
* If a promise returned by makeAttempt is rejected, schedule for retry by
putting it back on redis.

The Redis Priority Queue
--------------

The Redis priority queue is a sorted set. Members can be represented however the
user pleases, as long as the process that creates work and the makeAttempt
function agree on a format. For example, one simple strategy is to represent
work units as an integer, which corresponds to a database row containing the
work to be done. (However, note that NOT putting all information required by
a request on Redis will require a trip to a data store during makeAttempt!).

An Attempter is only responsible for putting work into this sorted set when it
is initialized, and when it is reconciled. If another process wants work
attempted prior to the next reconciliation, it will have to insert it into
Redis itself.

The score of members of the sorted set is a Unix timestamp to the millisecond.
This is required, since Attempter uses this to determine whether
events should be ordered or should continue to wait on the queue. Earlier
timestamps are popped off first.

Physical limits and failure conditions
------------

The current physical limit of this module is the memory of the host OS. Here's
how it should first fail as system load rises from 0:
* Given N units already in an Attempter's internal, pure-JS priority queue, the
  host system has enough memory to allow it to pull P members off of a redis key
  (using popAllOverdueWork) and then hold them in memory while inserting them
  each into a pure-Javascript priority queue
* At some point, >P units simultaneously exist in the Attempter's RedisPQ key
* The Attempter attempts to pop all of them at once
* Memory runs out
* Process crashes

On Ubuntu 14.04.2 LTS, inserting 1e7 Numbers into a pure-JavaScript priority
queue (implemented by https://github.com/adamhooper/js-priority-queue and using
that library's default BinaryHeapStrategy) takes up about 150 megabytes of
memory. (JS Numbers are 4 bytes, and the binary heap should use 1e7 nodes, each
of which contains a Number and two Number-sized pointers, for 4 * 3 * 1e7 bytes,
so this estimate seems pretty accurate.)

If an Attempter-hosting process is crashing because it's out of memory, use the
above information to debug/design a more scalable solution.


Reconciliation
--------------

No one's perfect.

Sometimes, work units get dropped. A Redis service flakes out or gets
overloaded, an Attempter crashes, taking the work in its in-process queue with
it, or some other disaster occurs.

We can't always prevent these from happening. But what we can do is periodically
stop an Attempter from running, clear the Redis work queue, and then restore
it to the state is should be in based on some underlying source of truth (often
an on-disk database).

Every so often (as determined by the reconciliationInterval option passed to
an Attempter instance on creation), an Attempter will do the following:
* Stop making new attempts
* Stop polling Redis for new work
* Wait until all attempts currently in flight are resolved or rejected.
* Flush both its JS, in-attempter PQ and its Redis PQ.
* Get waiting work from the system's source of truth using getPendingWorkUnits
* Put this work onto Redis
* Start polling Redis for work again
* Start handling attempts again


Running tests
-------------

Tests are currently scattered throughout the project, ending in ".test.js".
There is not yet a command to detect and run all of them dynamically, so you'll
have to run them individually with "node [path/to/file]".

Application-logic tests are in the same directories are their corresponding
files.

Performance tests are in ./performanceTests. They make requests and log out the
average requests/ms.