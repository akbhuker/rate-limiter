-- Token Bucket — smooth traffic shaping with controlled bursts.
--
-- A bucket holds up to `capacity` tokens and refills continuously at `rate`
-- tokens/ms. Each admitted request removes `cost` tokens. A request is blocked
-- when the bucket cannot cover its cost. Because refill is computed lazily from
-- the elapsed time since the last touch, we never need a background timer.
--
-- Atomic: the read of current tokens, the refill, and the debit all happen in
-- one server-side script, so two concurrent requests can't both spend the same
-- token.
--
-- KEYS[1]  hash key holding {tokens, ts}
-- ARGV[1]  now        (unix ms)
-- ARGV[2]  rate       (tokens per ms, float)
-- ARGV[3]  capacity   (max tokens / burst ceiling)
-- ARGV[4]  cost       (tokens this request consumes)
--
-- returns { allowed(0|1), remaining_tokens, retry_after_ms, reset_ms }

local key      = KEYS[1]
local now      = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local cost     = tonumber(ARGV[4])

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

-- Lazily refill based on elapsed time, clamped to capacity.
local delta = now - ts
if delta < 0 then delta = 0 end
tokens = math.min(capacity, tokens + delta * rate)

local allowed = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- TTL = time to refill a full bucket from empty, plus slack. Idle keys evict.
redis.call('PEXPIRE', key, math.ceil(capacity / rate) + 1000)

-- Time until the bucket holds enough tokens to admit a request of this cost.
local retry_after = 0
if allowed == 0 then
  retry_after = math.ceil((cost - tokens) / rate)
end

-- Time until the bucket is full again.
local reset = math.ceil((capacity - tokens) / rate)

return { allowed, math.floor(tokens), retry_after, reset }
