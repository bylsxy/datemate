"""把角色视图接到三种推理上；公开结果中不包含世界真值。"""

from __future__ import annotations

import json
from dataclasses import asdict, replace
from functools import lru_cache
from math import exp
from pathlib import Path

from .bayes import LocationBayes, ZeroLikelihoodError
from .evidence import CompleteConflictError, robust_fusion, standard_fusion
from .logic import Atom, Rule, Var, forward_chain
from .world import FRAME, AgentView, legal_actions


@lru_cache(maxsize=2)
def _load_trained(path: str, modified: int):
    from .learned import LearnedLocationModel

    return LearnedLocationModel.load(path)


def deployed_model():
    path = Path(__file__).resolve().parents[2] / "artifacts" / "research" / "model.json"
    return _load_trained(str(path), path.stat().st_mtime_ns) if path.exists() else None


def deployed_policy_config():
    from .policy import PolicyConfig

    path = Path(__file__).resolve().parents[2] / "artifacts" / "research" / "policy_config.json"
    return (
        PolicyConfig(**json.loads(path.read_text(encoding="utf-8")))
        if path.exists()
        else PolicyConfig()
    )


def campus_rules() -> tuple[Rule, ...]:
    observer, person, place, tick = map(Var, ("observer", "person", "place", "tick"))
    item, event = Var("item"), Var("event")
    return (
        Rule(
            "self-location",
            Atom("KnowsAt", (observer, observer, place, tick)),
            (Atom("OwnLocation", (observer, place)), Atom("CurrentTick", (tick,))),
        ),
        Rule(
            "sight-to-known",
            Atom("KnowsAt", (observer, person, place, tick)),
            (Atom("SawAt", (observer, person, place, tick)),),
        ),
        Rule(
            "known-to-meet",
            Atom("CanMeet", (observer, person)),
            (
                Atom("KnowsAt", (observer, person, place, tick)),
                Atom("OwnLocation", (observer, place)),
                Atom("CurrentTick", (tick,)),
                Atom("Different", (observer, person)),
            ),
        ),
        Rule(
            "meet-with-item",
            Atom("CanGive", (observer, person, item)),
            (Atom("CanMeet", (observer, person)), Atom("HasItem", (observer, item))),
        ),
        Rule(
            "gift-memory",
            Atom("RemembersGift", (observer, person, event)),
            (Atom("WitnessedGift", (observer, person, event)),),
        ),
    )


def facts_from_view(view: AgentView) -> set[Atom]:
    facts = {
        Atom("CurrentTick", (view.tick,)),
        Atom("OwnLocation", (view.actor_id, view.location)),
    }
    facts.update(Atom("HasItem", (view.actor_id, item)) for item in view.possessions)
    facts.update(Atom("Different", (view.actor_id, other)) for other in view.contacts)
    for record in view.observations:
        e = record.evidence
        if e.received_at > view.tick or e.observed_at > view.tick:
            continue
        facts.add(Atom("HeardReport", (view.actor_id, record.target, e.evidence_id)))
        for place in sorted(e.support or ()):
            facts.add(Atom("ReportSupports", (e.evidence_id, place)))
        if record.kind == "sighting" and e.observed_at == view.tick and len(e.support or ()) == 1:
            place = next(iter(e.support))
            facts.add(Atom("SawAt", (view.actor_id, record.target, place, view.tick)))
    for event in view.memories:
        if event.kind == "give":
            other = event.target if event.actor == view.actor_id else event.actor
            facts.add(Atom("WitnessedGift", (view.actor_id, other, event.event_id)))
    return facts


def atom_json(atom: Atom) -> dict:
    return {"predicate": atom.predicate, "args": list(atom.args)}


def analyze(view: AgentView, target: str = "xiaxi", *, model=None, policy_config=None) -> dict:
    model = model or deployed_model()
    evidence = view.evidence_for(target)
    logic = forward_chain(facts_from_view(view), campus_rules(), method="semi_naive")
    inferred = sorted(
        [atom_json(a) for a in logic.facts],
        key=lambda a: (a["predicate"], repr(a["args"])),
    )
    known = [
        a.args[2]
        for a in logic.facts
        if a.predicate == "KnowsAt" and a.args[0] == view.actor_id and a.args[1] == target
    ]
    try:
        if model is None:
            bayes = LocationBayes(sorted(FRAME), tau=20).infer(evidence, now=view.tick)
        else:
            from .policy import context_for_view

            bayes = model.infer(evidence, view.tick, context_for_view(view))
        bayes_data = {
            "status": "ok",
            "probabilities": bayes.probabilities,
            "trace": bayes.trace,
            "selected": list(bayes.selected_evidence_ids),
        }
    except ZeroLikelihoodError as exc:
        bayes_data = {
            "status": "zero_likelihood",
            "probabilities": {},
            "trace": {"reason": str(exc)},
            "selected": list(exc.selected_evidence_ids),
        }
    # 各方法使用相同的可见记录和相同的设计时效折扣。
    adjusted = tuple(
        replace(e, reliability=e.reliability * exp(-(view.tick - e.observed_at) / 20.0))
        for e in evidence
        if e.received_at <= view.tick and e.observed_at <= view.tick
    )
    preprocessing_discarded = ()
    if model is not None:
        from .learned import prepare_evidence

        prepared = prepare_evidence(evidence, view.tick)
        preprocessing_discarded = tuple(e.evidence_id for e in prepared.discarded)
        adjusted = tuple(
            replace(
                e,
                reliability=(
                    1.0
                    if e.evidence_id.startswith(("sight:", "self:"))
                    else model.source_reliability(e.source_id, view.tick - e.observed_at)
                    if e.source_id in model.sources
                    else e.reliability
                ),
            )
            for e in prepared.selected
        )
    methods = {}
    for name, function in (("dempster", standard_fusion), ("yager", robust_fusion)):
        try:
            result = function(adjusted, FRAME)
            methods[name] = {
                "status": "ok",
                "probabilities": result.pignistic(),
                "conflict": result.conflict,
                "ignorance": result.mass.masses.get(FRAME, 0.0),
                "selected": list(result.selected_evidence_ids),
                "discarded": [*preprocessing_discarded, *result.discarded_evidence_ids],
                "rule": result.rule,
            }
        except CompleteConflictError:
            methods[name] = {
                "status": "complete_conflict",
                "probabilities": {},
                "conflict": 1.0,
                "ignorance": 1.0,
            }
    probabilities = bayes_data["probabilities"]
    ranked = sorted(probabilities, key=lambda state: (-probabilities[state], state))
    best = ranked[0] if ranked else None
    conflict = methods["yager"]["conflict"]
    if known:
        decision = {
            "mode": "known",
            "location": known[0],
            "reason": "当前直接观察通过规则得到已知位置",
        }
    elif not probabilities or max(probabilities.values()) < 0.8 or conflict > 0.5:
        decision = {
            "mode": "verify",
            "location": best,
            "reason": "后验不足或证据冲突较高，建议先询问；当前为固定阈值策略",
        }
    else:
        decision = {
            "mode": "estimate",
            "location": best,
            "reason": "根据角色可见证据得到的位置估计",
        }
    policy = None
    if model is not None and getattr(view, "task", None) is not None:
        from .policy import choose_action

        policy = choose_action(
            view, model, config=policy_config or deployed_policy_config()
        ).as_dict()
    return {
        "actor": view.actor_id,
        "target": target,
        "tick": view.tick,
        "facts": inferred,
        "proof": [
            {
                "rule": d.rule_id,
                "fact": atom_json(d.fact),
                "binding": dict(d.binding),
                "premises": [atom_json(a) for a in d.premises],
            }
            for d in logic.trace
        ],
        "logic_metrics": logic.metrics.as_dict(),
        "bayes": bayes_data,
        "evidence_methods": methods,
        "decision": decision,
        "actions": [asdict(a) for a in legal_actions(view)],
        "policy": policy,
        "parameter_status": (
            f"训练模型 {model.training_id}；来源/时效参数来自训练集；策略参数由验证集配置"
            if model is not None
            else "机制夹具设计参数：时效常数20分钟、后验阈值0.8、冲突阈值0.5；正式模型生成后自动接入"
        ),
    }
