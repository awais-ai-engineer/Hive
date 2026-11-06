CATEGORIES = (
    "music", "gaming", "technology", "nature", "sports", "art", "education", "news",
    "business", "health", "food", "travel", "science", "movies", "books", "other",
)
CATEGORY_CHECK = "category IN (" + ",".join(f"'{value}'" for value in CATEGORIES) + ")"
