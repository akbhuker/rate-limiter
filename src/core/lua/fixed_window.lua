-- Fixed Window Counter — cheapest algorithm, one counter per window.
--
-- A single integer counts requests in the current window; it expires when the
-- window ends. Simple and O(1) memory, but allows up to 2x the limit across a
-- window boundary (the classic burst weakness) — included here as a baseline
-- and for endpoints where that's acceptable.
--
-- We INCRBY first, then roll back if the increment exceeded the limit, so a
-- rejected request does not permanently inflate the counter. All atomic.
--
-- KEYS[1]  counter key (should already encode the window bucket; see note)
-- ARGV[1]  limit     (max requests per window)
-- ARGV[2]  window    (ms)
-- ARGV[3]  cost      (requests this call consumes)
--
-- returns { allowed(0|1), remaining, reset_ms }

local key    = KEYS[1]
local limit  = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cost   = tonumber(ARGV[3])

local current = redis.call('INCRBY', key, cost)

-- First write into this window: arm the expiry that defines the window length.
if current == cost then
  redis.call('PEXPIRE', key, window)
end

local allowed = 1
if current > limit then
  allowed = 0
  -- Roll back so a blocked request doesn't keep the window saturated.
  redis.call('DECRBY', key, cost)
  current = current - cost
end

local ttl = redis.call('PTTL', key)
if ttl < 0 then ttl = window end

local remaining = limit - current
if remaining < 0 then remaining = 0 end

return { allowed, remaining, ttl }
