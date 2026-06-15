-- Sliding Window Counter (weighted two-window approximation).
--
-- Smooths out the boundary-burst problem of fixed windows without paying the
-- O(N) memory cost of a full request log. We keep the count for the CURRENT
-- fixed window plus the count for the PREVIOUS one, then estimate the rolling
-- count as:  current + previous * (overlap fraction of the previous window).
--
-- The whole script runs as a single atomic Redis call, so concurrent requests
-- on the same key can never interleave a read-modify-write -> no race, no
-- over-admission under high concurrency.
--
-- KEYS[1]  hash key holding {start, cur, prev}
-- ARGV[1]  now           (unix ms)
-- ARGV[2]  window        (ms)
-- ARGV[3]  limit         (max weighted requests per window)
-- ARGV[4]  cost          (weight of this request, usually 1)
--
-- returns { allowed(0|1), remaining, reset_ms, used_estimate }

local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local cost   = tonumber(ARGV[4])

local data  = redis.call('HMGET', key, 'start', 'cur', 'prev')
local start = tonumber(data[1])
local cur   = tonumber(data[2]) or 0
local prev  = tonumber(data[3]) or 0

if start == nil then
  start = now
end

local elapsed = now - start

-- Roll the window forward to the bucket that contains `now`.
if elapsed >= 2 * window then
  -- Both stored windows are stale; start fresh.
  prev = 0
  cur = 0
  start = now
  elapsed = 0
elseif elapsed >= window then
  -- Exactly one window boundary crossed: yesterday's "current" becomes "previous".
  prev = cur
  cur = 0
  start = start + window
  elapsed = now - start
end

-- Fraction of the previous window still inside the rolling window.
local weight    = (window - elapsed) / window
local estimated = cur + prev * weight

local allowed = 0
if estimated + cost <= limit then
  allowed = 1
  cur = cur + cost
  estimated = estimated + cost
end

redis.call('HSET', key, 'start', start, 'cur', cur, 'prev', prev)
-- Keep the key alive long enough to cover both contributing windows.
redis.call('PEXPIRE', key, 2 * window + 1000)

local remaining = limit - estimated
if remaining < 0 then remaining = 0 end

-- Time until the rolling estimate drops below the limit, approximated by the
-- time left in the current window.
local reset = window - elapsed

return { allowed, math.floor(remaining), math.floor(reset), math.floor(estimated) }
