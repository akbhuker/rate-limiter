-- Sliding Window Log — exact rolling-window limiting via a sorted set.
--
-- Every admitted request is recorded as a member scored by its timestamp.
-- On each call we evict entries older than the window, count what's left, and
-- admit only if there's room. This is the most ACCURATE algorithm (no
-- approximation, no boundary burst) at the cost of O(N) memory per key, so it
-- suits lower-volume, high-value endpoints (login, password reset, payments).
--
-- Atomic eviction + count + insert in one script prevents two requests from
-- both seeing "1 slot free" and both taking it.
--
-- KEYS[1]  sorted set key
-- ARGV[1]  now        (unix ms)
-- ARGV[2]  window     (ms)
-- ARGV[3]  limit      (max requests per rolling window)
-- ARGV[4]  cost       (number of slots this request consumes)
-- ARGV[5]  member     (unique id for this request, e.g. "<now>-<rand>")
--
-- returns { allowed(0|1), remaining, reset_ms }

local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local cost   = tonumber(ARGV[4])
local member = ARGV[5]

-- Drop everything that has aged out of the rolling window.
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

local count   = redis.call('ZCARD', key)
local allowed = 0

if count + cost <= limit then
  allowed = 1
  for i = 1, cost do
    redis.call('ZADD', key, now, member .. ':' .. i)
  end
  count = count + cost
end

redis.call('PEXPIRE', key, window + 1000)

local remaining = limit - count
if remaining < 0 then remaining = 0 end

-- Reset = when the oldest in-window entry expires, freeing a slot.
local reset = window
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if oldest[2] then
  reset = (tonumber(oldest[2]) + window) - now
  if reset < 0 then reset = 0 end
end

return { allowed, remaining, math.floor(reset) }
