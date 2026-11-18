from fastapi.testclient import TestClient

from campusecho.api import app

client = TestClient(app)


def test_session_role_boundary_and_debug_audit():
    response = client.post("/api/session", json={"scenario": "conflict"})
    assert response.status_code == 200
    payload = response.json()
    assert "audit" not in payload
    assert "snapshot" not in payload
    sid = payload["session_id"]
    roommate = client.get(f"/api/session/{sid}", params={"actor": "roommate"}).json()
    assert roommate["view"]["observations"] == []
    audit = client.get(f"/api/session/{sid}", params={"debug": True}).json()
    assert audit["audit"]["locations"]["xiaxi"] == "club"
    assert audit["analysis"]["bayes"] == payload["analysis"]["bayes"]


def test_action_atomicity_and_stale_revision():
    payload = client.post("/api/session", json={"scenario": "umbrella"}).json()
    sid = payload["session_id"]
    action = {"revision": 0, "kind": "give", "target": "xiaxi", "item": "umbrella", "minutes": 0}
    result = client.post(f"/api/session/{sid}/action", json=action)
    assert result.status_code == 200
    assert result.json()["revision"] == 1
    assert result.json()["view"]["possessions"] == []
    assert client.post(f"/api/session/{sid}/action", json=action).status_code == 409


def test_illegal_action_does_not_mutate_session():
    payload = client.post("/api/session", json={"scenario": "conflict"}).json()
    sid = payload["session_id"]
    action = {"revision": 0, "kind": "give", "target": "xiaxi", "item": "umbrella", "minutes": 0}
    assert client.post(f"/api/session/{sid}/action", json=action).status_code == 422
    assert client.get(f"/api/session/{sid}").json()["revision"] == 0


def test_static_interface_and_unknown_inputs():
    assert "CampusEcho" in client.get("/").text
    assert client.post("/api/session", json={"scenario": "unknown"}).status_code == 422
    assert client.get("/api/session/unknown").status_code == 404
