from fastapi.testclient import TestClient

from campusecho.api import app

client = TestClient(app)


def test_research_entry_graph_and_question_projection():
    assert "CampusEcho" in client.get("/").text
    assert "CampusEcho" in client.get("/classic").text
    graph = client.get("/api/graph")
    assert graph.status_code == 200
    payload = graph.json()
    assert payload["counts"]["entities"] == 504
    assert payload["counts"]["triples"] == 1234
    assert payload["nodes"] and payload["edges"]
    assert all(
        {"id", "source", "target", "relation"} <= set(edge)
        for edge in payload["edges"]
    )

    questions = client.get("/api/questions").json()
    assert {row["category"].split(" ", 1)[0] for row in questions["questions"]} == {
        "2",
        "3",
        "4",
    }
    assert all("answers" not in row and "paths" not in row for row in questions["questions"])


def test_search_returns_public_trace_without_private_labels():
    question = client.get("/api/questions").json()["questions"][0]
    response = client.post(
        "/api/search",
        json={
            "question_id": question["id"],
            "question": question["query"],
            "entities": question["entities"],
            "algorithm": "astar",
            "max_steps": 128,
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "completed"
    assert payload["algorithm"] == "astar"
    assert payload["steps"]
    assert payload["evidence_path"]
    assert "answers_private" not in response.text
    assert "paths" not in payload
    assert client.get(f"/api/search/{payload['run_id']}").json() == payload


def test_search_returns_a_real_parent_child_tree_including_bfs():
    question = client.get("/api/questions").json()["questions"][0]
    response = client.post(
        "/api/search",
        json={
            "question_id": question["id"],
            "question": question["query"],
            "entities": question["entities"],
            "algorithm": "bfs",
            "max_steps": 128,
        },
    )
    assert response.status_code == 200
    tree = response.json()["tree"]
    nodes = {node["id"]: node for node in tree["nodes"]}
    assert tree["root_id"] in nodes
    assert nodes[tree["root_id"]]["parent_id"] is None
    assert tree["edges"]
    assert all(edge["source"] in nodes and edge["target"] in nodes for edge in tree["edges"])
    assert all(
        node["parent_id"] is None or node["parent_id"] in nodes
        for node in tree["nodes"]
    )
    assert any(node["status"] == "expanded" for node in tree["nodes"])


def test_search_validation_and_missing_run():
    assert (
        client.post("/api/search", json={"algorithm": "unknown"}).status_code == 422
    )
    assert (
        client.post("/api/search", json={"algorithm": "bfs", "max_steps": 0}).status_code
        == 422
    )
    assert client.get("/api/search/not-a-run").status_code == 404


def test_hybrid_search_algorithms_are_live_api_paths():
    question = client.get("/api/questions").json()["questions"][0]
    for algorithm in ("ga_astar", "ga_classifier"):
        response = client.post(
            "/api/search",
            json={
                "question_id": question["id"],
                "algorithm": algorithm,
                "max_steps": 128,
            },
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["algorithm"] == algorithm
        assert payload["status"] == "completed"
        assert payload["steps"]


def test_sandbox_adoption_requires_real_search_and_returns_world_state():
    question = client.get("/api/questions").json()["questions"][0]
    run = client.post(
        "/api/search",
        json={
            "question_id": question["id"],
            "algorithm": "bfs",
            "max_steps": 128,
        },
    ).json()
    response = client.post(
        "/api/sandbox/adopt",
        json={
            "run_id": run["run_id"],
            "question_id": question["id"],
            "topic": "find",
            "evidence_ids": [],
            "people": ["roommate", "clubmate"],
            "resources": {
                "minutes": 40,
                "travel_mode": "escort",
                "umbrella": True,
            },
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "adopted"
    assert payload["run_id"] == run["run_id"]
    assert payload["route"][0] == "teaching"
    assert payload["world_state"]["location"] in {"club", "walkway"}

    missing = client.post(
        "/api/sandbox/adopt",
        json={
            "run_id": "missing",
            "topic": "find",
            "resources": {"minutes": 40},
        },
    )
    assert missing.status_code == 404
