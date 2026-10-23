"""The app's clock: US Eastern time (the Florida warehouse), whatever time zone the PC running the app is set to.

Every date and time the app records (a scan, an edit, a hold, a sync) and every hour on the Dashboard uses this clock,
so the people in the Philippines and in the warehouse read the same times. Daylight saving follows the US rule:
it starts on the second Sunday of March at 2:00 and ends on the first Sunday of November at 2:00.
"""
from datetime import datetime, timedelta, timezone


def _nth_sunday(year, month, n):
    d = datetime(year, month, 1)
    d += timedelta(days=(6 - d.weekday()) % 7)  # the first Sunday
    return d + timedelta(weeks=n - 1)


def offset_minutes(utc=None):
    """Minutes to add to US Eastern time to get UTC (300 in winter, 240 in summer time)."""
    utc = utc or datetime.now(timezone.utc).replace(tzinfo=None)
    start = _nth_sunday(utc.year, 3, 2) + timedelta(hours=7)   # 2:00 EST is 07:00 UTC
    end = _nth_sunday(utc.year, 11, 1) + timedelta(hours=6)    # 2:00 EDT is 06:00 UTC
    return 240 if start <= utc < end else 300


def now():
    """The current US Eastern date and time, without a time zone attached."""
    utc = datetime.now(timezone.utc).replace(tzinfo=None)
    return utc - timedelta(minutes=offset_minutes(utc))
