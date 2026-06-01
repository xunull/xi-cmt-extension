import asyncio
import hashlib
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import AsyncIterator, Awaitable, Callable

logger = logging.getLogger(__name__)


@dataclass
class RetryPolicy:
    max_attempts: int = 3
    base_delay: float = 0.5
    max_delay: float = 8.0
    retry_on: tuple[type[BaseException], ...] = field(default_factory=lambda: (ConnectionError, TimeoutError))


async def with_retry(fn: Callable[[], Awaitable[bytes]], policy: RetryPolicy) -> bytes:
    last_err: BaseException | None = None
    for attempt in range(1, policy.max_attempts + 1):
        try:
            return await fn()
        except policy.retry_on as err:
            last_err = err
            if attempt == policy.max_attempts:
                break
            delay = min(policy.base_delay * (2 ** (attempt - 1)), policy.max_delay)
            logger.warning("retry %d/%d after %.1fs: %r", attempt, policy.max_attempts, delay, err)
            await asyncio.sleep(delay)
    assert last_err is not None
    raise last_err


@asynccontextmanager
async def lease(name: str, lock: asyncio.Lock) -> AsyncIterator[str]:
    await lock.acquire()
    try:
        token = hashlib.sha256(name.encode()).hexdigest()[:8]
        yield token
    finally:
        lock.release()


def chunked(data: bytes, size: int) -> list[bytes]:
    if size <= 0:
        raise ValueError("size must be positive")
    return [data[i : i + size] for i in range(0, len(data), size)]
