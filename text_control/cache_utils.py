"""
Cache utilities module - Provides safe access to Flask-Caching instance
"""

import inspect
from functools import wraps

from flask import current_app


def get_cache():
    """Get the cache instance from the current Flask app"""
    try:
        # Flask-Caching creates a cache attribute on the app
        return getattr(current_app, "cache", None)
    except RuntimeError:
        # Return None if no app context available
        return None


def cache_result(timeout=50, key_prefix="default"):
    """Decorator that caches function results if cache is available"""

    def decorator(func):
        if inspect.iscoroutinefunction(func):
            # Handle async functions
            @wraps(func)
            async def async_wrapper(*args, **kwargs):
                cache = get_cache()
                if cache is None:
                    # No cache available, execute function directly
                    return await func(*args, **kwargs)

                # Create cache key
                cache_key = f"{key_prefix}_{func.__name__}"

                # Try to get from cache
                result = cache.get(cache_key)
                if result is not None:
                    return result

                # Execute function and cache result
                result = await func(*args, **kwargs)
                cache.set(cache_key, result, timeout=timeout)
                return result

            return async_wrapper

        # Handle sync functions
        @wraps(func)
        def sync_wrapper(*args, **kwargs):
            cache = get_cache()
            if cache is None:
                # No cache available, execute function directly
                return func(*args, **kwargs)

            # Create cache key
            cache_key = f"{key_prefix}_{func.__name__}"

            # Try to get from cache
            result = cache.get(cache_key)
            if result is not None:
                return result

            # Execute function and cache result
            result = func(*args, **kwargs)
            cache.set(cache_key, result, timeout=timeout)
            return result

        return sync_wrapper

    return decorator
