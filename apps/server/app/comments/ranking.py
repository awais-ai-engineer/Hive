"""Ranking algorithms for comments.

Pure functions for sorting comment trees.
"""

import math

Z_WILSON = 1.281551565545  # 80% confidence interval lower bound


def wilson_score(upvotes: int, downvotes: int) -> float:
    """Calculate the lower bound of the Wilson score interval for comment sorting.

    Why Wilson score beats raw score or ratio:
    Raw score (upvotes - downvotes) favours early comments with high volume over
    consistently high-quality comments, while raw percentage (upvotes / total)
    gives a comment with 1 upvote and 0 downvotes a 100% rating despite near-zero
    statistical confidence.

    The Wilson score interval models ratings as a Bernoulli trial and returns the
    conservative lower bound of the confidence interval (here 80% confidence).
    A comment with 40 upvotes and 5 downvotes (~89% positive with n=45) yields
    a high lower bound (~0.81), beating a comment with 1 upvote and 0 downvotes
    (~0.38) where uncertainty is massive.
    """
    total = upvotes + downvotes
    if total <= 0:
        return 0.0
    pos = upvotes / total
    z = Z_WILSON
    denominator = 1.0 + (z * z) / total
    centre_adjusted_probability = pos + (z * z) / (2.0 * total)
    adjusted_standard_deviation = math.sqrt(
        (pos * (1.0 - pos) + (z * z) / (4.0 * total)) / total
    )
    lower_bound = (
        centre_adjusted_probability - z * adjusted_standard_deviation
    ) / denominator
    return lower_bound


def sort_comments(nodes: list[dict], sort: str = "best") -> list[dict]:
    """Recursively sort comment nodes and their replies in-place or returning a new list.

    Sorting among siblings:
    - best: wilson_score desc, then id desc (newer first on ties)
    - top: score desc, then id desc
    - new: id desc
    - old: id asc
    """
    if sort == "best":
        nodes.sort(key=lambda c: (wilson_score(c.get("upvotes", 0), c.get("downvotes", 0)), c.get("id", "")), reverse=True)
    elif sort == "top":
        nodes.sort(key=lambda c: (c.get("score", 0), c.get("id", "")), reverse=True)
    elif sort == "new":
        nodes.sort(key=lambda c: c.get("id", ""), reverse=True)
    elif sort == "old":
        nodes.sort(key=lambda c: c.get("id", ""), reverse=False)

    for node in nodes:
        if node.get("replies"):
            sort_comments(node["replies"], sort)

    return nodes
