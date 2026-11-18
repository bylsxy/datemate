"""CampusEcho 本地服务；推理工作台与角色世界保持独立数据边界。"""

from dataclasses import asdict
from pathlib import Path
from threading import RLock
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .engine import analyze
from .research_api import ResearchService, SandboxService, graph_payload, questions_payload
from .world import EDGES, PLACES, Action, WorldState, observe, scenario, step, task_summary_view

app = FastAPI(title="CampusEcho", version="0.3.0")
_sessions: dict[str, tuple[WorldState, int]] = {}
_lock = RLock()
_research = ResearchService()
_sandbox = SandboxService()


class NewSession(BaseModel):
    scenario: str = "mission"
    seed: int = 17


class ActionRequest(BaseModel):
    revision: int = Field(ge=0)
    kind: str
    actor_id: str = "player"
    target: str = ""
    item: str = ""
    minutes: int = Field(default=2, ge=0, le=60)


class SearchRequest(BaseModel):
    question: str = ""
    question_id: str | None = None
    entities: list[str] = Field(default_factory=list)
    algorithm: str = "astar"
    max_steps: int = Field(default=128, ge=1, le=512)


class AdoptionRequest(BaseModel):
    question: str = ""
    question_id: str | None = None
    run_id: str
    topic: str
    evidence_ids: list[str] = Field(default_factory=list)
    people: list[str] = Field(default_factory=list)
    resources: dict[str, object] = Field(default_factory=dict)


def _payload(world: WorldState, revision: int, actor: str, debug: bool = False) -> dict:
    view = observe(world, actor)
    result = {
        "revision": revision,
        "view": {
            "actor": view.actor_id,
            "location": view.location,
            "tick": view.tick,
            "possessions": view.possessions,
            "observations": [
                {
                    "id": o.evidence.evidence_id,
                    "source": o.evidence.source_id,
                    "origin": o.evidence.origin_id,
                    "support": sorted(o.evidence.support or ()),
                    "observed_at": o.evidence.observed_at,
                    "received_at": o.evidence.received_at,
                    "reliability": o.evidence.reliability,
                    "kind": o.kind,
                }
                for o in view.observations
                if o.target == "xiaxi"
            ],
            "memories": [asdict(e) for e in view.memories],
        },
        "analysis": analyze(view),
        "labels": {**PLACES, "transit": "在途"},
        "task": task_summary_view(view),
        "map": {"edges": list(EDGES), "places": PLACES},
    }
    if debug:
        result["audit"] = {
            "locations": {a.actor_id: a.location for a in world.actors},
            "seed": world.seed,
            "note": "研究者审计真值；该数据未传给推理器",
        }
    return result


@app.get("/")
def index():
    return FileResponse(Path(__file__).parent / "static" / "research.html")


@app.get("/classic")
def classic_index():
    return FileResponse(Path(__file__).parent / "static" / "index.html")


@app.get("/research.css")
def research_css():
    return FileResponse(Path(__file__).parent / "static" / "research.css")


@app.get("/research.js")
def research_js():
    return FileResponse(Path(__file__).parent / "static" / "research.js")


@app.get("/api/graph")
def graph():
    return graph_payload()


@app.get("/api/questions")
def questions():
    return questions_payload()


@app.post("/api/search")
def run_search(request: SearchRequest):
    try:
        return _research.run_search(
            question_id=request.question_id,
            algorithm=request.algorithm,
            max_steps=request.max_steps,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/search/{run_id}")
def read_search(run_id: str):
    try:
        return _research.read_run(run_id)
    except KeyError as exc:
        raise HTTPException(404, "搜索运行不存在或已过期") from exc


@app.post("/api/sandbox/adopt")
def adopt_sandbox(request: AdoptionRequest):
    try:
        run = _research.get_run(request.run_id)
        return _sandbox.adopt(
            run=run,
            topic=request.topic,
            people=request.people,
            resources=request.resources,
        )
    except KeyError as exc:
        raise HTTPException(404, "搜索运行不存在或已过期") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/api/session")
def create_session(request: NewSession):
    try:
        world = scenario(request.scenario, request.seed)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    with _lock:
        if len(_sessions) >= 64:
            raise HTTPException(429, "本地会话已达到64个，请重启实验台释放内存")
        session_id = uuid4().hex
        _sessions[session_id] = (world, 0)
    return {"session_id": session_id, **_payload(world, 0, "player")}


@app.get("/api/session/{session_id}")
def read_session(session_id: str, actor: str = "player", debug: bool = False):
    with _lock:
        if session_id not in _sessions:
            raise HTTPException(404, "会话不存在")
        world, revision = _sessions[session_id]
    try:
        return _payload(world, revision, actor, debug)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/api/session/{session_id}/action")
def apply_action(session_id: str, request: ActionRequest):
    with _lock:
        if session_id not in _sessions:
            raise HTTPException(404, "会话不存在")
        world, revision = _sessions[session_id]
        if revision != request.revision:
            raise HTTPException(409, "世界状态已更新，请刷新后重试")
        try:
            updated = step(world, Action(**request.model_dump(exclude={"revision"})))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        _sessions[session_id] = (updated, revision + 1)
    return _payload(updated, revision + 1, request.actor_id)
