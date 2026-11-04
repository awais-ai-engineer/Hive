import math
from datetime import datetime


def hot_score(score: int, created_at: datetime) -> float:
    """A log score gives each 10x votes about 12.5 hours; epoch makes newer rise steadily."""
    epoch = created_at.timestamp()
    magnitude = math.log10(max(abs(score), 1))
    return round((1 if score > 0 else -1 if score < 0 else 0) * magnitude + epoch / 45000, 7)
