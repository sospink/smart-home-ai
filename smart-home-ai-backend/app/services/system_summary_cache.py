"""公开运行摘要缓存失效信号。"""

_generation = 0


def get_system_summary_generation() -> int:
    return _generation


def invalidate_system_summary() -> int:
    global _generation
    _generation += 1
    return _generation
