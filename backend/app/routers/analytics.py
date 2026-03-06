"""Router for analytics endpoints.

Each endpoint performs SQL aggregation queries on the interaction data
populated by the ETL pipeline. All endpoints require a `lab` query
parameter to filter results by lab (e.g., "lab-01").
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.database import get_session
from app.models.item import ItemRecord
from app.models.interaction import InteractionLog
from app.models.learner import Learner

router = APIRouter()


def _get_id(obj):
    """Get id from a Row or model instance."""
    # For Row objects, try to get the first column value
    if hasattr(obj, '__getitem__') and not isinstance(obj, str):
        try:
            val = obj[0]
            # Check if it's actually an int (not a mapped object)
            if isinstance(val, int):
                return val
        except (TypeError, IndexError, KeyError):
            pass
    
    # For model instances, use getattr to access the id attribute
    try:
        val = getattr(obj, 'id', None)
        if isinstance(val, int):
            return val
    except (AttributeError, TypeError):
        pass
    
    # Fallback: return 0
    return 0


def _get_title(obj):
    """Get title from a Row or model instance."""
    # For Row objects, try to get the second column value
    if hasattr(obj, '__getitem__') and not isinstance(obj, str):
        try:
            val = obj[1]
            # Check if it's actually a str (not a mapped object)
            if isinstance(val, str):
                return val
        except (TypeError, IndexError, KeyError):
            pass
    
    # For model instances, use getattr to access the title attribute
    try:
        val = getattr(obj, 'title', None)
        if isinstance(val, str):
            return val
    except (AttributeError, TypeError):
        pass
    
    return ""


@router.get("/scores")
async def get_scores(
    lab: str = Query(..., description="Lab identifier, e.g. 'lab-01'"),
    session: AsyncSession = Depends(get_session),
):
    """Score distribution histogram for a given lab.

    - Find the lab item by matching title (e.g. "lab-04" → title contains "Lab 04")
    - Find all tasks that belong to this lab (parent_id = lab.id)
    - Query interactions for these items that have a score
    - Group scores into buckets: "0-25", "26-50", "51-75", "76-100"
      using CASE WHEN expressions
    - Return a JSON array:
      [{"bucket": "0-25", "count": 12}, {"bucket": "26-50", "count": 8}, ...]
    - Always return all four buckets, even if count is 0
    """
    # Parse lab identifier: "lab-04" → "Lab 04"
    lab_num = lab.replace("lab-", "")

    # Find the lab item by looking for items with type='lab' and title containing "Lab XX"
    lab_result = await session.exec(
        select(ItemRecord.id).where(
            ItemRecord.type == "lab",
            ItemRecord.title.ilike(f"%Lab {lab_num}%")
        )
    )
    lab_id = lab_result.one_or_none()

    if not lab_id:
        return [
            {"bucket": "0-25", "count": 0},
            {"bucket": "26-50", "count": 0},
            {"bucket": "51-75", "count": 0},
            {"bucket": "76-100", "count": 0},
        ]

    # Extract the integer ID from the Row object
    if hasattr(lab_id, '__getitem__'):
        lab_id = lab_id[0]

    # Find all task items that belong to this lab
    task_result = await session.exec(
        select(ItemRecord.id).where(ItemRecord.parent_id == lab_id)
    )
    # Extract integer IDs from Row objects
    task_ids = [row[0] for row in task_result.all()]

    if not task_ids:
        return [
            {"bucket": "0-25", "count": 0},
            {"bucket": "26-50", "count": 0},
            {"bucket": "51-75", "count": 0},
            {"bucket": "76-100", "count": 0},
        ]

    # Build the bucket CASE expression
    bucket_expr = case(
        (InteractionLog.score <= 25, "0-25"),
        (InteractionLog.score <= 50, "26-50"),
        (InteractionLog.score <= 75, "51-75"),
        else_="76-100",
    )

    # Query interactions for these tasks with scores, grouped by bucket
    stmt = (
        select(bucket_expr.label("bucket"), func.count().label("count"))
        .select_from(InteractionLog)
        .where(InteractionLog.item_id.in_(task_ids))
        .where(InteractionLog.score.isnot(None))
        .group_by(bucket_expr)
    )

    result = await session.exec(stmt)
    bucket_counts = {row.bucket: row.count for row in result.all()}

    # Return all four buckets, even if count is 0
    return [
        {"bucket": "0-25", "count": bucket_counts.get("0-25", 0)},
        {"bucket": "26-50", "count": bucket_counts.get("26-50", 0)},
        {"bucket": "51-75", "count": bucket_counts.get("51-75", 0)},
        {"bucket": "76-100", "count": bucket_counts.get("76-100", 0)},
    ]


@router.get("/pass-rates")
async def get_pass_rates(
    lab: str = Query(..., description="Lab identifier, e.g. 'lab-01'"),
    session: AsyncSession = Depends(get_session),
):
    """Per-task pass rates for a given lab.

    - Find the lab item and its child task items
    - For each task, compute:
      - avg_score: average of interaction scores (round to 1 decimal)
      - attempts: total number of interactions
    - Return a JSON array:
      [{"task": "Repository Setup", "avg_score": 92.3, "attempts": 150}, ...]
    - Order by task title
    """
    # Parse lab identifier: "lab-04" → "Lab 04"
    lab_num = lab.replace("lab-", "")

    # Find the lab item
    lab_result = await session.exec(
        select(ItemRecord.id, ItemRecord.title).where(
            ItemRecord.type == "lab",
            ItemRecord.title.ilike(f"%Lab {lab_num}%")
        )
    )
    lab_row = lab_result.one_or_none()

    if not lab_row:
        return []

    lab_id, lab_title = lab_row

    # Find all task items that belong to this lab
    task_result = await session.exec(
        select(ItemRecord.id, ItemRecord.title).where(ItemRecord.parent_id == lab_id)
    )
    tasks = list(task_result.all())

    results = []
    for task_id, task_title in sorted(tasks, key=lambda t: t[1]):
        # Query avg_score and attempts for this task
        stmt = (
            select(
                func.avg(InteractionLog.score).label("avg_score"),
                func.count().label("attempts"),
            )
            .select_from(InteractionLog)
            .where(InteractionLog.item_id == task_id)
            .where(InteractionLog.score.isnot(None))
        )
        result = await session.exec(stmt)
        row = result.one_or_none()

        if row and row.attempts > 0:
            avg_score = round(float(row.avg_score), 1) if row.avg_score else 0.0
            results.append({
                "task": task_title,
                "avg_score": avg_score,
                "attempts": row.attempts,
            })

    return results


@router.get("/timeline")
async def get_timeline(
    lab: str = Query(..., description="Lab identifier, e.g. 'lab-01'"),
    session: AsyncSession = Depends(get_session),
):
    """Submissions per day for a given lab.

    - Find the lab item and its child task items
    - Group interactions by date (use func.date(created_at))
    - Count the number of submissions per day
    - Return a JSON array:
      [{"date": "2026-02-28", "submissions": 45}, ...]
    - Order by date ascending
    """
    # Parse lab identifier: "lab-04" → "Lab 04"
    lab_num = lab.replace("lab-", "")

    # Find the lab item
    lab_result = await session.exec(
        select(ItemRecord.id).where(
            ItemRecord.type == "lab",
            ItemRecord.title.ilike(f"%Lab {lab_num}%")
        )
    )
    lab_id = lab_result.one_or_none()

    if not lab_id:
        return []

    # Extract the integer ID from the Row object
    if hasattr(lab_id, '__getitem__'):
        lab_id = lab_id[0]

    # Find all task items that belong to this lab
    task_result = await session.exec(
        select(ItemRecord.id).where(ItemRecord.parent_id == lab_id)
    )
    # Extract integer IDs from Row objects
    task_ids = [row[0] for row in task_result.all()]

    if not task_ids:
        return []

    # Query interactions grouped by date
    stmt = (
        select(
            func.date(InteractionLog.created_at).label("date"),
            func.count().label("submissions"),
        )
        .select_from(InteractionLog)
        .where(InteractionLog.item_id.in_(task_ids))
        .group_by(func.date(InteractionLog.created_at))
        .order_by(func.date(InteractionLog.created_at))
    )

    result = await session.exec(stmt)
    return [{"date": row.date, "submissions": row.submissions} for row in result.all()]


@router.get("/groups")
async def get_groups(
    lab: str = Query(..., description="Lab identifier, e.g. 'lab-01'"),
    session: AsyncSession = Depends(get_session),
):
    """Per-group performance for a given lab.

    - Find the lab item and its child task items
    - Join interactions with learners to get student_group
    - For each group, compute:
      - avg_score: average score (round to 1 decimal)
      - students: count of distinct learners
    - Return a JSON array:
      [{"group": "B23-CS-01", "avg_score": 78.5, "students": 25}, ...]
    - Order by group name
    """
    # Parse lab identifier: "lab-04" → "Lab 04"
    lab_num = lab.replace("lab-", "")

    # Find the lab item
    lab_result = await session.exec(
        select(ItemRecord.id).where(
            ItemRecord.type == "lab",
            ItemRecord.title.ilike(f"%Lab {lab_num}%")
        )
    )
    lab_id = lab_result.one_or_none()

    if not lab_id:
        return []

    # Extract the integer ID from the Row object
    if hasattr(lab_id, '__getitem__'):
        lab_id = lab_id[0]

    # Find all task items that belong to this lab
    task_result = await session.exec(
        select(ItemRecord.id).where(ItemRecord.parent_id == lab_id)
    )
    # Extract integer IDs from Row objects
    task_ids = [row[0] for row in task_result.all()]

    if not task_ids:
        return []

    # Query interactions joined with learners, grouped by student_group
    stmt = (
        select(
            Learner.student_group.label("group"),
            func.avg(InteractionLog.score).label("avg_score"),
            func.count(Learner.id.distinct()).label("students"),
        )
        .select_from(InteractionLog)
        .join(Learner, InteractionLog.learner_id == Learner.id)
        .where(InteractionLog.item_id.in_(task_ids))
        .where(InteractionLog.score.isnot(None))
        .group_by(Learner.student_group)
        .order_by(Learner.student_group)
    )

    result = await session.exec(stmt)
    results = []
    for row in result.all():
        avg_score = round(float(row.avg_score), 1) if row.avg_score else 0.0
        results.append({
            "group": row.group,
            "avg_score": avg_score,
            "students": row.students,
        })

    return results
