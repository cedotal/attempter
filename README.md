Attempter
============

Attempter is a module that attempts to perform some arbitrary action and, upon
failure, retries it.

What attempter is for
---------------

Attempter is designed to handle system actions that:
* Are initially requested from a process that needs to remain responsive
** For instance, a web-facing process receives a request to perform a
   long-running background task
* In terms of running time, primarily consist of waiting on I/O
* Can fail without compromising the correctness of the entire program
** Yes, there's an almost complete overlap between that and tasks that are
   I/O-bound
* Are subject to concurrency limits
** For example: "no more than N attempts are permitted at once, because each
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
* **maxActiveAttempts (Number, not required)**: A concurrency limiter. Note that
  the process of loading units from the work queue requires a single network
  connection, so take that into account when you pass a value here. Defaults
  to 480.
* **retryDelay (Number, not required)**: In milliseconds. Defaults to 10000.

An instance of attempter does the following once created:
* Constantly attempts to load work into itself from a Redis-backed priority
  queue
* Attempts to handle as many loaded units as it is allowed to concurrently,
  using makeAttempt for each
* If the promise returned by makeAttempt is rejected, schedule for retry

The Redis Priority Queue
--------------

The Redis priority queue is a sorted set. Members can be represented however the
user pleases, as long as the process that creates work and the makeAttempt
function agree on a format. (One simple strategy is to represent work units as
an integer, which corresponds to a database row containing the work to be done.)

An Attempter is NOT responsible for putting work in this sorted set! If another
process does not put work in, Attempter will never do anything.

The score of members of the sorted set is a Unix timestamp to the millisecond.
This is required, since Attempter uses this to determine whether
events should be ordered or should continue to wait on the queue. Earlier
timestamps are popped off first.

Physical limits and failure conditions
------------

The current physical limit of this system is the memory of the host OS. Here's
how it should first fail as system load rises from 0:
* Given N units already in an Attempter's internal, pure-JS priority queue, the
  host system has enough memory to allow it to pull P members off of a redis key
  (using popAllOverdueWork) and then hold them in memory while inserting them
  each into a pure-Javascript priority queue
* >P units simultaneously exist in the Attempter's Redis sorted set
* The Attempter attempts to pop all of them at once
* Memory runs out
* Process crashes

On Ubuntu 14.04.2 LTS, inserting 1e7 Numbers into a pure-JavaScript priority
queue (implemented by https://github.com/adamhooper/js-priority-queue and using
that library's default BinaryHeapStrategy) takes up about 150 megabytes of
memory. JS Numbers are 4 bytes, and the binary heap should use 1e7 nodes, each
of which contains a Number and two Number-sized pointers, for 4 * 3 * 1e7 bytes,
so this actually seems pretty accurate.

If an Attempter-hosting process is crashing because it's out of memory, use the
above information to debug/design a more scalable solution.


Reconciliation
--------------

No one's perfect.

Sometimes, work units get dropped. A Redis service flakes out or gets
overloaded, an Attempter crashes, taking the work in its in-process queue with
it, or some other disaster occurs.

We can't always prevent these from happening. But what we can do is periodically
stop our Attempters from running, clear the Redis work queue, and then restore
it to the state is should be in based on some underlying source of truth (often
an on-disk database).

This is what the Reconciler class is for.

TODO explain intended behavior of Reconciler

TODO implement Reconciler


Running tests
-------------

Tests are currently scattered throughout the project, ending in ".test.js".
There is not yet a command to detect and run all of them dynamically, so you'll
have to run them individually with "node [path/to/file]".