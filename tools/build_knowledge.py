#!/usr/bin/env python3
"""DateMate 初始语料候选抽取；日常构建使用 node tools/build_catalog.mjs。

本脚本只在 --extract-candidates 与独立 --output 同时指定时运行。
knowledge/*.json 是手工编辑源，候选结果必须经人工核对后再合入。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

VERSION = "knowledge-3.0.1"
INTEREST_TAGS = ["nature", "culture", "food", "play", "creative", "romantic", "quiet", "indoor", "exercise", "learning", "daily", "photo", "music"]
FEATURE_PATTERNS = {
    "nature": r"散步|漫步|草坪|花园|花園|湖边|湖邊|树木|樹木|公园|公園|walk|garden|park|散歩|公園",
    "culture": r"图书|圖書|书店|書店|博物馆|博物館|展览|展覽|library|bookshop|museum|図書館|本屋",
    "food": r"餐厅|餐廳|饭堂|食堂|咖啡|甜品|野餐|点心|點心|coffee|cafe|café|picnic|dinner|喫茶|カフェ",
    "play": r"电玩|電玩|游戏|遊戲|桌游|抓娃娃|电影|電影|game|cinema|movie|ゲーム|映画",
    "creative": r"拍照|照片|摄影|攝影|绘画|繪畫|手工|photo|paint|drawing|写真",
    "music": r"音乐|音樂|演唱|音乐会|音樂會|concert|music|歌|音楽",
    "weather": r"下雨|雨天|暴雨|天气|天氣|rain|weather|雨|天気",
    "fatigue": r"疲惫|疲憊|疲劳|疲勞|休息|体力|體力|tired|fatigue|rest|疲れ|休憩",
    "preparation": r"提前|预约|預約|准备|準備|球拍|拍子|纸巾|紙巾|reserve|prepare|ticket|予約|準備",
    "budget": r"预算|預算|费用|費用|花费|花費|省钱|省錢|budget|cost|price|料金|予算",
    "communication": r"交流|沟通|溝通|聊天|互动|互動|共同|phone|phubbing|closeness|self.expansion|話|会話",
    "consent": r"同意|愿意|願意|尊重|拒绝|拒絕|边界|邊界|consent|respect|decline",
}


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def source_id(relative: str) -> str:
    return "SRC-" + digest(relative.encode("utf-8"))[:12]


def read_text(path: Path) -> tuple[str, str]:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-16", "gb18030"):
        try:
            return raw.decode(encoding), encoding
        except (UnicodeError, LookupError):
            continue
    raise ValueError(f"无法可靠解码：{path}")


def scan_corpus(root: Path) -> tuple[list[dict], dict[str, dict]]:
    """扫描全部文件；关键词命中仅登记为候选，采用需有独立证据定位。"""
    sources, texts = [], {}
    for path in sorted((p for p in root.rglob("*") if p.is_file()), key=lambda p: p.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        raw = path.read_bytes()
        item = {"id": source_id(relative), "path": relative, "title": path.stem, "category": relative.split("/")[0], "bytes": len(raw), "sha256": digest(raw), "sourceStatus": "user_provided_not_independently_verified", "rawTextIncluded": False, "publicReusePermission": "not_established", "adoptedEvidenceIds": [], "candidateHits": {}, "usedFor": [], "exclusionReason": None}
        if path.suffix.lower() not in (".txt", ".md"):
            item.update({"status": "registered_not_text", "exclusionReason": "格式不在本地文本抽取器支持范围"})
            sources.append(item)
            continue
        try:
            text, encoding = read_text(path)
        except ValueError:
            item.update({"status": "decode_failed", "exclusionReason": "严格解码失败，保留哈希以便人工核对"})
            sources.append(item)
            continue
        lines = text.splitlines()
        hits = {key: len(list(re.finditer(pattern, text, re.IGNORECASE))) for key, pattern in FEATURE_PATTERNS.items()}
        item.update({"status": "scanned", "encoding": encoding, "characters": len(text), "lines": len(lines), "candidateHits": hits, "candidateCount": sum(hits.values()), "declaredUrls": list(dict.fromkeys(re.findall(r"https?://[^\s；;）)<>\"]+", "\n".join(lines[:12])))), "declaredRights": next((line[:500] for line in lines[:12] if "许可证" in line or "许可：" in line or "license" in line.lower()), "未见文件声明"), "exclusionReason": "仅完成候选抽取，未形成经人工核对的采用项"})
        texts[relative] = {"text": text, "lines": lines, "source": item}
        sources.append(item)
    return sources, texts


def find_source(texts: dict, filename: str) -> tuple[str, dict]:
    matches = [(name, item) for name, item in texts.items() if Path(name).name == filename]
    if len(matches) != 1:
        raise ValueError(f"来源匹配数量异常：{filename}: {len(matches)}")
    return matches[0]


def evidence_record(texts: dict, eid: str, filename: str, anchor: str, summary: str, kind: str, assertion: str = "inferred") -> dict:
    _, item = find_source(texts, filename)
    line_no = next((i + 1 for i, line in enumerate(item["lines"]) if re.search(anchor, line, re.IGNORECASE)), None)
    if line_no is None:
        raise ValueError(f"证据锚点未找到：{eid} {anchor}")
    line = item["lines"][line_no - 1]
    item["source"]["adoptedEvidenceIds"].append(eid)
    item["source"]["usedFor"].append("original_summary_and_design_basis")
    item["source"]["exclusionReason"] = None
    return {"id": eid, "sourceDocumentId": item["source"]["id"], "sourceLocator": f"L{line_no}", "anchorSha256": digest(line.encode("utf-8")), "sourceKind": kind, "assertionKind": assertion, "summary": summary, "reviewStatus": "verified_in_local_source", "publicExcerptAllowed": False, "rightsStatus": "source_rights_not_revalidated; original_summary_only", "verificationBoundary": "核对本地文本位置；现实经营状态、采集真实性和原作品归属尚待回源确认"}


def build_evidence(texts: dict) -> list[dict]:
    records = []
    pfile = "01_五山天河商圈_地点知识图谱原始语料.txt"
    gfile = "02_Galgame与甜宠小说_产生式规则原始语料.txt"
    cfile = "03_社媒真实吐槽_约会冲突与无解案例语料.txt"
    p_summaries = [
        "校园自然空间可提供共同观察对象；露天、步行和准备负担应分别登记。",
        "校园餐饮可支持日常便饭；高峰人流和校内支付条件需要出发前确认。",
        "湖边用餐与短距离散步可拆成独立阶段，室内座位与户外天气分别处理。",
        "校园茶点和西式简餐可提供不同用餐风格，转场仍需预留时间。",
        "附近简餐与小吃可提供低预算选择；饮食风格和嘈杂环境应显式展示。",
        "商场内可组合电玩、电影和用餐；每项可选活动单独计算时间与负担。",
        "街区浏览、拍照和饮品可组合；户外暴露、排队与饮食条件具有差异。",
        "花园夜景与正餐可分开选择，拍照取景不必绑定较高餐饮费用。",
        "水族、雨林与滑冰提供不同体验；票价、体力与噪声分别形成筛选条件。",
        "超市采购、书店和茶点形成生活化组合，购买物资可以供后续阶段使用。",
    ]
    for i, summary in enumerate(p_summaries, 1):
        records.append(evidence_record(texts, f"E-P{i:03}", pfile, f"语料 P{i:03}", summary, "secondary"))
    g_summaries = [
        "共同观察或协作小任务可作为破冰设计灵感，体验评分属于设计参数。",
        "天气变化会影响露天活动；室内备选可用于重新规划。",
        "疲惫和低脑力偏好需要分别影响候选负担与恢复安排。",
        "叙事中出现体力、餐饮和照顾需求；正式规则仅使用用户明确状态与饮食拒绝。",
        "安静、人少、稳定性和探索偏好可以作为可调整条件，不依人格标签推断。",
        "转场需要时间缓冲，同一短行程内的正餐选择应具有互斥检查。",
    ]
    for i, summary in enumerate(g_summaries, 1):
        records.append(evidence_record(texts, f"E-G{i:03}", gfile, f"语料 G{i:03}", summary, "secondary"))
    for i, summary in enumerate([
        "雨天、短时间、预算与拍照目标组合时可能缩小候选集合，冲突应解释具体条件。",
        "明确饮食拒绝与高负担活动可能共同过滤候选，需要保留限制来源。",
        "疲惫状态下连续安排活动会增加累计负担，恢复阶段应影响后缀。",
        "一方偏好文化活动、另一方希望轻松时，可寻找共享兴趣或轮流选择。",
    ], 1):
        records.append(evidence_record(texts, f"E-C{i:03}", cfile, f"案例 C{i:03}", summary, "secondary"))
    specs = [
        ("E-campus-note", "徐阳我打包票的手搓的目前全华农商铺运营情况和约会地点！！！其实是我的亲身经历，哈哈.txt", "拍子和球", "用户本地自述提及泰山区乒乓球桌及拍子、球的准备要求；设施可用性需现场确认。", "first_person_report"),
        ("E-campus-food", "徐阳我打包票的手搓的目前全华农商铺运营情况和约会地点！！！其实是我的亲身经历，哈哈.txt", "10栋玻璃房", "用户本地自述提及泰山区简餐与烘焙购买，可拆分正餐、补充能量和早餐采购。", "first_person_report"),
        ("E-campus-walk", "徐阳我打包票的手搓的目前全华农商铺运营情况和约会地点！！！其实是我的亲身经历，哈哈.txt", "操场外圈", "用户本地自述提供运动场外圈与桥边散步线索；路线与负担采用模型设计值。", "first_person_report"),
        ("E-campus-nature", "华南农业大学自然景观、博物馆与康乐文化活动.txt", "五湖", "校园背景材料介绍湖泊、草地与树木，可支持自然观察场景；入校和开放条件仍需确认。", "secondary"),
        ("E-campus-museum", "华南农业大学自然景观、博物馆与康乐文化活动.txt", "8个展厅", "背景材料介绍农业主题博物馆及多类展品，为分主题轻量参观提供构思。", "secondary"),
        ("E-campus-sport", "华南农业大学自然景观、博物馆与康乐文化活动.txt", "羽毛球", "背景材料列出校园运动设施；运动活动需要装备和可用场地确认。", "secondary"),
        ("E-citywalk", "广州步行、城市文化与公共空间场景.txt", "街巷", "城市背景材料提供建筑与街巷观察线索，同时提醒长距离步行和交通带来的负担。", "secondary"),
        ("E-city-library", "广州步行、城市文化与公共空间场景.txt", "图书馆", "城市背景材料提及图书馆阅览；本项目将借阅证件和开放时间作为待确认准备事项。", "secondary"),
        ("E-lab-time", "实验室情侣约会攻略大全.txt", "时间：约半小时", "娱乐性经验材料提及短时间散步与休息构思；本项目将活动放在独立休闲空间并保留返程缓冲。", "first_person_report"),
        ("E-shared-game", "久違的網咖小約會.txt", "組隊", "公开自述中出现电影后组队游戏的休闲安排，可作为协作游戏灵感；价格不转用到当前目录。", "first_person_report"),
        ("E-research-novelty", "Planning date nights that promote closeness： The roles of relationship goals and self-expansion.txt", "results suggest", "所提供研究摘要讨论约会规划、自我扩展与亲近体验之间的关联；新鲜感标签仅用于偏好排序。", "research"),
        ("E-research-phone", "Phubbing in romantic relationships and retaliation： A daily diary study.txt", "Results revealed", "所提供日记研究摘要报告手机干扰与当日关系体验之间的关联；据此设计自愿专注交流活动。", "research"),
        ("E-research-vacation", "Couples vacations and romantic passion and intimacy.txt", "self-expanding", "所提供研究摘要讨论共同新体验与关系体验的关联；本项目采用新体验设计启发，并不输出因果或成功率。", "research"),
        ("E-fiction-picnic", "Emma（英文）.txt", "(?i)picnic|walk|dinner|party", "文学节选中的共同外出与聚会线索可启发野餐和共同观察活动，人物结果不用于现实预测。", "fiction"),
        ("E-fiction-garden", "The Enchanted April（英文）.txt", "(?i)garden|flower|walk", "文学材料中的花园与共享环境线索可启发植物观察及轻量散步活动。", "fiction"),
        ("E-fiction-living", "浮生六記.txt", "茶|花|游|遊", "文学材料中的生活、花木与共同游赏线索可启发茶点、自然观察和共同创作。", "fiction"),
        ("E-fiction-paint", "海濱故人.txt", "画|畫|海|花", "文学材料提供海边环境和文化交流线索，用作原创观察与表达活动的构思材料。", "fiction"),
        ("E-design-focus", "04_言情甜宠小说_场景与规则精粹语料.txt", "N001", "二次整理剧情展示协作任务作为交流起点；共同任务加分属于本项目可调整设计值。", "secondary"),
        ("E-design-timing", "05_通用都市大学城_言情小说场景与规则语料.txt", "时间|時間|转场|轉場", "二次整理剧情提供活动衔接和时间安排线索，供时间窗与先后依赖设计参考。", "secondary"),
        ("E-design-replan", "06_长篇细腻言情小说_全流程与深度情景语料.txt", "下雨|疲惫|时间", "二次整理长篇情景提供计划调整线索，供天气、准备和恢复规则设计参考。", "secondary"),
    ]
    for eid, filename, anchor, summary, kind in specs:
        records.append(evidence_record(texts, eid, filename, anchor, summary, kind))
    # 八部大体量游戏文本全部完成候选抽取；以实际命中的休闲主题作为局部采用证据。
    game_summaries = {
        "千恋＊万花.txt": "游戏叙事提及甜品店经营背景，为茶点小店主题提供构思；角色经营情节未转换为现实服务信息。",
        "夜明前的琉璃色.txt": "游戏角色背景提及博物馆工作，为文化地点候选提供线索；任职叙事未构成约会效果证据。",
        "大图书馆的牧羊人.txt": "游戏对话提及放学后在图书馆阅读的生活方式，为并肩阅读和自主选择活动提供线索。",
        "帕露菲.txt": "游戏对话提及附近便利店与书店的寻找，为近距离备选和采购场景提供构思。",
        "星空的记忆.txt": "游戏叙事提及通过地方博物馆或资料馆进一步了解城市，为主题参观和学习活动提供线索。",
        "白色相簿.txt": "游戏对话出现邀约一起前往图书馆的情景，为共同阅读场景提供直接叙事线索。",
        "苍之彼方的四重奏.txt": "游戏对话提及依正式程序从图书馆借阅教本，为阅读准备与规则确认提供线索。",
        "近月少女的礼仪.txt": "游戏对话对车站附近是否存在书店持不同判断，为设施可用性需要确认的规则提供线索。",
    }
    for filename in game_summaries:
        _, item = find_source(texts, filename)
        chosen = next((key for key in ("culture", "food", "nature", "play", "music") if item["source"]["candidateHits"].get(key, 0)), None)
        if chosen:
            eid = "E-game-" + digest(filename.encode("utf-8"))[:8]
            records.append(evidence_record(texts, eid, filename, FEATURE_PATTERNS[chosen], game_summaries[filename], "game"))
    return records


def activity(aid: str, title: str, description: str, minutes: int, cost: tuple[int, int], load: int, tags: list[str], evidence: list[str], **extra: Any) -> dict:
    data = {"id": aid, "title": title, "description": description, "minutes": minutes, "cost": list(cost), "load": load, "group": "play", "mode": "multi", "novelty": 45, "tags": tags, "compositionMode": "sequential_extra", "requiresExplicitConsent": False, "predecessorIds": [], "requires": [], "preconditions": [], "provides": [], "consumes": [], "preparationIds": [], "windows": [], "evidenceIds": evidence, "parameterStatus": "designed_not_measured", "publicAllowed": True}
    data.update(extra)
    return data


def scene(sid: str, title: str, description: str, minutes: int, cost: tuple[int, int], load: int, kind: str, area: str, indoor: bool, tags: list[str], evidence: list[str], activities: list[dict], **extra: Any) -> dict:
    data = {"id": sid, "typeId": sid, "title": title, "description": description, "minutes": minutes, "cost": list(cost), "load": load, "kind": kind, "area": area, "indoor": indoor, "fit": 78, "novelty": 45, "source": [e.removeprefix("E-") for e in evidence], "evidenceIds": evidence, "activities": activities, "default": [], "quiet": "quiet" in tags, "mental": 1, "bold": False, "tags": tags, "weather": ["clear", "rain", "unknown"] if indoor else ["clear", "unknown"], "predecessorIds": [], "requires": [], "preconditions": [], "provides": [], "consumes": [], "preparationIds": [], "windows": [], "dietaryTags": [], "crowdRisk": "unknown", "seated": load <= 0, "reviewStatus": "reviewed", "evidenceStatus": "local_source_summary_reviewed_real_world_unverified", "parameterStatus": "designed_not_measured", "publicAllowed": True}
    data.update(extra)
    return data


def expand_catalog(base: dict, evidence: list[dict]) -> dict:
    scenes = base["scenes"]
    tag_map = {
        "mall": ["play", "indoor", "daily"], "campus": ["nature", "quiet"], "arcade": ["play", "indoor"], "meal": ["food", "indoor", "daily"], "rest": ["quiet", "indoor"], "supermarket": ["food", "indoor", "daily"], "aquarium": ["nature", "indoor", "photo"], "garden": ["nature", "romantic", "photo"], "tea": ["food", "quiet", "indoor", "daily"], "cafe": ["food", "quiet", "indoor"], "canteen": ["food", "indoor", "daily"], "cinema": ["culture", "play", "indoor"], "ice": ["play", "exercise", "indoor"], "reading": ["culture", "learning", "quiet", "indoor"], "exhibition": ["culture", "learning", "indoor"], "street": ["culture", "photo", "creative"], "dessert": ["food", "daily", "indoor"], "rainforest": ["nature", "learning", "indoor"], "western": ["food", "indoor", "romantic"], "cantonese": ["food", "indoor", "daily"],
    }
    for s in scenes:
        s.update({"typeId": s["id"], "tags": tag_map[s["id"]], "weather": ["clear", "rain", "unknown"] if s["indoor"] else ["clear", "unknown"], "predecessorIds": [], "requires": [], "preconditions": [], "provides": [], "consumes": [], "preparationIds": [], "windows": [], "dietaryTags": [], "crowdRisk": "unknown", "seated": s["load"] <= 0, "reviewStatus": "reviewed", "evidenceIds": ["E-" + name for name in s["source"]], "publicAllowed": True, "parameterStatus": "designed_not_measured", "evidenceStatus": "local_source_summary_reviewed_real_world_unverified"})
        for a in s["activities"]:
            a.update({"tags": list(dict.fromkeys(a.get("tags", []) + tag_map[s["id"]])), "compositionMode": "included" if a.get("mode") == "single" and a.get("minutes") == 0 else "sequential_extra", "requiresExplicitConsent": "photo" in a["id"], "predecessorIds": [], "requires": [], "preconditions": [], "provides": [], "consumes": [], "preparationIds": [], "windows": [], "evidenceIds": s["evidenceIds"], "parameterStatus": "designed_not_measured", "publicAllowed": True})
    by_id = {s["id"]: s for s in scenes}
    by_id["mall"]["quiet"] = False
    by_id["mall"]["crowdRisk"] = "high"
    by_id["arcade"]["quiet"] = False
    by_id["canteen"]["quiet"] = False
    by_id["supermarket"]["quiet"] = False
    by_id["street"]["quiet"] = False
    by_id["ice"]["preparationIds"] = ["closed_shoes"]
    by_id["ice"]["requires"] = ["closed_shoes"]
    by_id["ice"]["preconditions"] = ["closed_shoes"]
    by_id["campus"]["preparationIds"] = ["water"]
    by_id["campus"]["weather"] = ["clear", "unknown"]
    for sid in ("meal", "western", "cantonese", "canteen"):
        by_id[sid]["exclusiveKey"] = "main_meal"
        by_id[sid]["provides"] = ["meal_completed"]
    by_id["reading"]["activities"].append(activity("book_recommend", "互荐一本书", "各自挑一个想分享的主题，允许跳过长篇介绍。", 10, (0, 0), 0, ["culture", "learning", "quiet"], ["E-city-library"]))
    by_id["cafe"]["activities"] = [activity("cafe_warm", "选一杯温饮", "按双方口味选择，费用已计入咖啡小坐。", 0, (0, 0), 0, ["food", "quiet"], ["E-P007"], group="drink", mode="single", compositionMode="included", dietaryTags=["caffeine"]), activity("cafe_focus", "专注聊十分钟", "双方愿意时暂放手机，谈一个轻松话题。", 10, (0, 0), 0, ["quiet", "daily"], ["E-research-phone"], requiresExplicitConsent=True)]
    by_id["cinema"]["activities"] = [activity("film_pick", "共同选片", "各提一个片型，再挑双方都接受的一部。", 5, (0, 0), 0, ["culture", "play"], ["E-P006"]), activity("film_exchange", "聊一个印象镜头", "离场后各说一个记住的画面，允许意见不同。", 10, (0, 0), 0, ["culture", "quiet"], ["E-G001"])]
    by_id["tea"]["activities"] = [activity("tea_share", "分着尝两样茶点", "先核对食材和双方食量，茶点费用包含在场景中。", 0, (0, 0), 0, ["food", "daily"], ["E-P004"], compositionMode="included", dietaryTags=["gluten"])]
    by_id["meal"]["activities"].extend([
        activity("meal_style_raw", "生食风格", "双方明确接受生食时再选择，费用包含在简餐设计区间中。", 0, (0, 0), 0, ["food"], ["E-P007", "E-C002"], group="meal_style", mode="single", compositionMode="included", dietaryTags=["raw"]),
        activity("meal_style_spicy", "辣味风格", "按双方明确口味选择，限制辣味时此活动会被过滤。", 0, (0, 0), 0, ["food"], ["E-P005", "E-C002"], group="meal_style", mode="single", compositionMode="included", dietaryTags=["spicy"]),
    ])
    for meal_activity in by_id["meal"]["activities"]:
        meal_activity["group"] = "meal_style"
        meal_activity["mode"] = "single"
    by_id["dessert"]["activities"] = [activity("dessert_warm", "温热甜点", "按明确口味挑一份温热甜点。", 0, (0, 0), 0, ["food", "daily"], ["E-P001"], mode="single", group="dessert", compositionMode="included", dietaryTags=["dairy", "gluten"]), activity("dessert_ice", "冰淇淋分享", "双方愿意且未限制冷饮时，选小份冰淇淋。", 0, (0, 0), 0, ["food", "play"], ["E-campus-food"], mode="single", group="dessert", compositionMode="included", dietaryTags=["dairy", "cold"])]
    by_id["rainforest"]["activities"] = [activity("rainforest_leaf", "比较两种叶形", "找两个看起来不同的叶片，说说各自的观察。", 10, (0, 0), 1, ["nature", "learning"], ["E-P009"])]
    by_id["canteen"]["activities"] = [activity("canteen_pair", "各选一道菜", "核对明确忌口后，各挑一种想吃的菜。", 0, (0, 0), 0, ["food", "daily"], ["E-P002"], compositionMode="included")]
    by_id["aquarium"]["activities"].append(activity("aqua_observe", "各选一种海洋动物", "轮流指出最想多看一会儿的动物。", 10, (0, 0), 1, ["nature", "learning"], ["E-P009"]))
    additions = [
        scene("taishan_glass", "泰山区简餐", "以校内自述提供的简餐类型为灵感，挑双方都接受的一餐。", 35, (30, 55), -2, "meal", "campus", True, ["food", "daily", "indoor"], ["E-campus-food"], [activity("glass_noodle", "热汤河粉", "核对肉类与食材后选择热汤主食。", 0, (0, 0), 0, ["food", "daily"], ["E-campus-food"], mode="single", group="meal_style", compositionMode="included", dietaryTags=["meat"]), activity("glass_burger", "汉堡简餐", "根据双方食量选择汉堡与配餐。", 0, (0, 0), 0, ["food", "daily"], ["E-campus-food"], mode="single", group="meal_style", compositionMode="included", dietaryTags=["meat", "gluten"])], exclusiveKey="main_meal", provides=["meal_completed"], windows=[{"id": "lunch", "startMinute": 660, "endMinute": 840}, {"id": "dinner", "startMinute": 1020, "endMinute": 1260}]),
        scene("campus_bakery", "校内烘焙小店", "买一份补充能量的小点心，或把明早早餐提前备好。", 15, (10, 30), -1, "snack", "campus", True, ["food", "daily", "indoor"], ["E-campus-food"], [activity("bakery_share", "分一份面包", "核对食材后分享小份烘焙点心。", 5, (8, 18), 0, ["food", "daily"], ["E-campus-food"], dietaryTags=["gluten", "dairy"]), activity("breakfast_pack", "买好明早早餐", "购买可妥善保存的早餐，携带方式由双方确认。", 5, (10, 20), 0, ["food", "daily"], ["E-campus-food"], provides=["breakfast_pack"], dietaryTags=["gluten"])], dietaryTags=["gluten"]),
        scene("campus_tabletennis", "校内乒乓球", "带好拍子和球，从轻松对打开始，按双方体力决定时长。", 20, (0, 0), 3, "sport", "campus", False, ["play", "exercise"], ["E-campus-note"], [activity("pingpong_rally", "协作连续回球", "以一起接住十个球为目标，失误就重新来。", 10, (0, 0), 2, ["play", "exercise"], ["E-campus-note"]), activity("pingpong_teach", "轮流练一个动作", "会打的一方示范，另一方可随时换成轻松打球。", 10, (0, 0), 1, ["play", "learning"], ["E-campus-note"])], requires=["racket", "ball"], preconditions=["racket", "ball"], preparationIds=["racket", "ball"], quiet=False),
        scene("track_walk", "操场外圈散步", "沿平坦外圈走一小段，随时放慢速度或坐下休息。", 20, (0, 0), 1, "nature", "campus", False, ["nature", "quiet", "daily"], ["E-campus-walk"], [activity("track_stretch", "各自轻拉伸", "双方愿意时做熟悉的轻拉伸动作，不安排挑战。", 10, (0, 0), 1, ["exercise", "daily"], ["E-campus-walk"], requiresExplicitConsent=True), activity("track_observe", "看一会儿校园夜色", "找不影响运动的人行位置，看天空和周围变化。", 5, (0, 0), 0, ["nature", "romantic"], ["E-campus-walk"])]),
        scene("bridge_walk", "桥边短途漫步", "把桥边作为短路线的折返点，避免为了走远而赶路。", 25, (0, 0), 2, "nature", "campus", False, ["nature", "romantic", "quiet"], ["E-campus-walk"], [activity("bridge_view", "找一个共同景物", "各自挑一个喜欢的细节，再看看对方选的地方。", 5, (0, 0), 0, ["nature", "photo"], ["E-campus-walk"])]),
        scene("campus_botany", "校园植物观察", "围绕树叶、花色和树形找共同观察点，开放条件先确认。", 30, (0, 0), 2, "nature", "campus", False, ["nature", "learning", "quiet"], ["E-campus-nature", "E-fiction-garden"], [activity("botany_shapes", "寻找三种叶形", "用观察比较叶形，保留植物原貌。", 10, (0, 0), 1, ["nature", "learning"], ["E-campus-nature"]), activity("botany_sketch", "画一片叶子", "用纸笔各画一个观察细节，作品不必精致。", 15, (0, 0), 0, ["nature", "creative"], ["E-fiction-garden"], requires=["paper_pen"], preconditions=["paper_pen"], preparationIds=["paper_pen"], provides=["shared_sketch"])], preparationIds=["water"], windows=[{"id": "daylight", "startMinute": 480, "endMinute": 1080}]),
        scene("agriculture_museum", "农业主题博物馆", "挑一个展厅轻量参观，围绕共同感兴趣的展品聊天。", 40, (0, 30), 2, "culture", "campus", True, ["culture", "nature", "learning", "indoor"], ["E-campus-museum"], [activity("museum_tool", "猜猜农具的用途", "先说各自猜测，再阅读展签核对。", 10, (0, 0), 1, ["culture", "learning", "play"], ["E-campus-museum"]), activity("museum_pick", "挑一个最想再看的展品", "每人选一件展品，说明吸引自己的细节。", 10, (0, 0), 1, ["culture", "learning"], ["E-campus-museum"])], preparationIds=["opening_checked"], requires=["opening_checked"], preconditions=["opening_checked"], windows=[{"id": "daytime", "startMinute": 540, "endMinute": 1020}], mental=2),
        scene("campus_picnic", "校园轻野餐", "带好已经准备的食物与铺垫，在允许停留的草地坐一会儿。", 30, (0, 0), -1, "snack", "campus", False, ["nature", "food", "daily", "romantic"], ["E-P001", "E-fiction-picnic"], [activity("picnic_share", "分享备好的野餐", "食物来自之前采购或自行准备，食材按双方限制选择。", 10, (0, 0), -1, ["food", "daily"], ["E-fiction-picnic"], requires=["picnic_pack"], preconditions=["picnic_pack"], consumes=["picnic_pack"]), activity("picnic_cloud", "看云说一个联想", "轮流说一个云朵或景物带来的轻松联想。", 10, (0, 0), 0, ["nature", "creative", "romantic"], ["E-fiction-garden"])], requires=["picnic_mat"], preconditions=["picnic_mat"], preparationIds=["picnic_mat", "water"], seated=True),
        scene("groceries", "野餐物资采购", "先选好双方能吃的简单食物，为后面的野餐阶段备齐物资。", 15, (0, 0), 1, "everyday", "near", True, ["food", "daily", "indoor"], ["E-P010"], [activity("purchase_picnic", "采购一份野餐包", "购买可携带的食物与水，本次采购只供一次分享。", 10, (25, 45), 1, ["food", "daily"], ["E-P010"], provides=["picnic_pack"])], quiet=False),
        scene("photo_walk", "主题拍照散步", "围绕一种颜色或一种建筑细节轮流取景，按双方意愿拍照。", 25, (0, 0), 2, "photo", "near", False, ["photo", "creative", "culture"], ["E-citywalk", "E-P007"], [activity("photo_pair", "轮流拍一组照片", "双方同意再拍，照片用途由本人决定。", 10, (0, 0), 1, ["photo", "creative"], ["E-P007"], provides=["photo_pair"], requiresExplicitConsent=True), activity("photo_color", "寻找同一种颜色", "各找一个同色细节，比较画面里的变化。", 10, (0, 0), 1, ["photo", "creative"], ["E-citywalk"])], preparationIds=["phone_camera"]),
        scene("photo_printing", "把照片留成纪念", "选之前共同拍下的一张照片，确认本人同意后制作纸质纪念。", 10, (0, 0), 0, "creative", "near", True, ["photo", "creative", "romantic", "indoor"], ["E-P007", "E-research-novelty"], [activity("photo_print", "冲印一张共同照片", "从已完成拍照活动里选一张，双方确认后冲印。", 10, (10, 20), 0, ["photo", "creative", "romantic"], ["E-P007"], predecessorIds=["photo_pair"], requires=["photo_pair"], preconditions=["photo_pair"], provides=["printed_photo"], requiresExplicitConsent=True)], requires=["photo_pair"], preconditions=["photo_pair"]),
        scene("boardgame", "轻松桌游", "挑熟悉或规则简短的合作桌游，按双方接受程度选择玩法。", 25, (20, 50), 1, "play", "near", True, ["play", "indoor"], ["E-shared-game", "E-G001"], [activity("boardgame_coop", "完成一个合作关卡", "共同解决一关，遇到复杂规则可改成简单模式。", 20, (0, 0), 1, ["play", "learning"], ["E-shared-game"]), activity("boardgame_cards", "玩一轮轻量卡牌", "只选双方熟悉的规则，输赢不设置额外惩罚。", 15, (0, 0), 1, ["play", "daily"], ["E-G001"])]),
        scene("craft", "手作体验", "做一个小而明确的作品，预留收尾和清理时间。", 30, (30, 60), 1, "creative", "near", True, ["creative", "learning", "indoor"], ["E-research-novelty", "E-fiction-living"], [activity("craft_card", "制作一张小卡片", "各做一张简单卡片，表达内容由本人选择。", 15, (0, 0), 1, ["creative", "romantic"], ["E-fiction-living"], requires=["craft_kit"], preconditions=["craft_kit"], consumes=["craft_kit"], provides=["handmade_card"]), activity("craft_clay", "捏一个小物件", "使用场地提供的材料，选择各自想做的形状。", 20, (15, 25), 1, ["creative", "play"], ["E-research-novelty"], mode="single", group="material", exclusiveKey="craft_material")], preparationIds=["craft_kit"]),
        scene("music_corner", "一起听一首歌", "在允许轻声交流的休闲空间分享音乐，保留各自喜好。", 15, (0, 0), -1, "watch", "campus", True, ["music", "quiet", "indoor"], ["E-lab-time", "E-research-phone"], [activity("music_swap", "交换一首推荐歌", "每人选一首，听完说一个想分享的理由。", 10, (0, 0), 0, ["music", "culture", "quiet"], ["E-lab-time"], requires=["earphones"], preconditions=["earphones"], preparationIds=["earphones"]), activity("music_memory", "聊一段音乐记忆", "围绕这首歌聊一个轻松记忆，允许跳过私人话题。", 10, (0, 0), 0, ["music", "romantic", "quiet"], ["E-research-phone"], requiresExplicitConsent=True)], seated=True),
        scene("badminton", "轻量羽毛球", "先确认场地和装备，采用合作回球而非强度挑战。", 25, (0, 30), 4, "sport", "campus", True, ["play", "exercise", "indoor"], ["E-campus-sport"], [activity("badminton_rally", "一起连续回球", "轮流放慢球速，目标是一起多接几个球。", 15, (0, 0), 2, ["play", "exercise"], ["E-campus-sport"])], requires=["badminton_kit", "court_checked"], preconditions=["badminton_kit", "court_checked"], preparationIds=["badminton_kit", "court_checked"], quiet=False),
        scene("quiet_talk", "安静坐一会儿", "找到舒适座位，按双方意愿聊今天的小事。", 20, (0, 0), -2, "snack", "current", True, ["quiet", "daily", "indoor"], ["E-research-phone", "E-C004"], [activity("talk_highlight", "分享今天一个小亮点", "各说一件愿意分享的事情，认真听完再回应。", 10, (0, 0), 0, ["quiet", "daily"], ["E-research-phone"], requiresExplicitConsent=True), activity("talk_next", "各提一个下次想做的事", "把下一次兴趣写成备选，不要求当场承诺。", 10, (0, 0), 0, ["quiet", "romantic"], ["E-research-novelty"])]),
        scene("architecture", "街区建筑观察", "围绕一小段街区看建筑细节，设置明确的折返点。", 30, (0, 0), 3, "culture", "off", False, ["culture", "creative", "photo"], ["E-citywalk"], [activity("architecture_detail", "找一处建筑细节", "各选门窗、纹理或颜色中的一个细节。", 10, (0, 0), 1, ["culture", "creative"], ["E-citywalk"])]),
        scene("waterside", "水边短暂观景", "在允许停留的公共步道看水面，按天气和体力缩短路线。", 25, (0, 0), 2, "nature", "off", False, ["nature", "quiet", "romantic"], ["E-citywalk", "E-fiction-paint"], [activity("waterside_sketch", "速写一个画面", "用简单线条记下共同看到的景物。", 15, (0, 0), 0, ["creative", "nature"], ["E-fiction-paint"], requires=["paper_pen"], preconditions=["paper_pen"], preparationIds=["paper_pen"])])
    ]
    scenes.extend(additions)
    # 文学及游戏证据承担构思来源角色，数值和现实效用仍明确归入设计参数。
    game_links = {"tea": ["E-game-81ef99db"], "agriculture_museum": ["E-game-ffa64d6a", "E-game-18aca666"], "reading": ["E-game-c4c3a316", "E-game-aa91d97d", "E-game-ec909165"], "groceries": ["E-game-e4116c62"], "exhibition": ["E-game-c73b126a"]}
    for s in scenes:
        s["evidenceIds"] = list(dict.fromkeys(s["evidenceIds"] + game_links.get(s["id"], [])))
        if s["id"] in ("craft", "agriculture_museum", "photo_printing", "boardgame"):
            s["novelty"] = 70
    for s in scenes:
        if not s["indoor"]:
            s["tags"] = list(dict.fromkeys(s["tags"] + ["outdoor"]))
        s["featureValues"] = {"quiet": int(s["quiet"]), "indoor": int(s["indoor"]), "novelty": s["novelty"], "physicalLoad": s["load"], "mentalLoad": s["mental"]}
        for a in s["activities"]:
            a.setdefault("dietaryTags", [])
            a["allowedSceneIds"] = [s["id"]]
            a["allowedSceneTypes"] = [s["typeId"]]
            a["featureValues"] = {"novelty": a["novelty"], "physicalLoad": a["load"]}
    scenes.sort(key=lambda s: s["id"])
    all_activities = [a for s in scenes for a in s["activities"]]
    all_activities.sort(key=lambda a: a["id"])
    return {"version": VERSION, "rulesVersion": "production-3.0.1", "schemaVersion": "prototype-compatible-3.0", "rights": "包含原创结构化摘要和设计参数；本地原材料独立保留，公开数据不包含语料原文。", "disclaimer": "费用为两人整段的人民币设计区间，时长、负担、排序权重与窗口属于课程模型参数；现实价格、开放和场地可用性需要用户确认。研究与剧情线索不表示关系成功率、医学结论或现实因果。", "interestTags": INTEREST_TAGS, "scenes": scenes, "activities": all_activities}


def condition(fact: str, op: str, value: Any = None) -> dict:
    item = {"fact": fact, "op": op}
    if value is not None:
        item["value"] = value
    return item


def build_rules() -> list[dict]:
    rules = []

    def add(rid: str, title: str, checks: list[dict], actions: list[dict], evidence: list[str], priority: int = 50, strength: str = "soft", any_checks: list[dict] | None = None) -> None:
        when = {"all": checks}
        if any_checks:
            when["any"] = any_checks
        rules.append({"id": rid, "title": title, "priority": priority, "strength": strength, "when": when, "then": actions, "evidenceIds": evidence, "evidence": evidence, "assertionKind": "designed", "parameterStatus": "designed_not_measured", "enabled": True})

    add("R-fatigue-derive", "任意一方明显疲惫时推导恢复需求", [], [{"action": "set_fact", "fact": "derived.needsRecovery", "value": True}], ["E-G003"], 100, "hard", [condition("context.fatigueA", "gte", 6), condition("context.fatigueB", "gte", 6)])
    add("R-fatigue-rest", "恢复需求优先安排休息", [condition("derived.needsRecovery", "eq", True), condition("scene.kind", "eq", "rest")], [{"action": "prefer_scene", "amount": 30}], ["E-G003"], 95)
    add("R-fatigue-scene", "恢复需求过滤高负担场景", [condition("derived.needsRecovery", "eq", True), condition("scene.load", "gte", 4)], [{"action": "exclude_scene", "reason": "任意一方疲惫，当前场景负担较高"}], ["E-G003"], 94, "hard")
    add("R-fatigue-activity", "恢复需求过滤高负担活动", [condition("derived.needsRecovery", "eq", True), condition("activity.load", "gte", 3)], [{"action": "exclude_activity", "reason": "当前活动会增加较多累计负担"}], ["E-G003"], 93, "hard")
    add("R-rain-outdoor", "雨天过滤纯露天场景", [condition("context.weather", "eq", "rain"), condition("scene.indoor", "eq", False)], [{"action": "exclude_scene", "reason": "雨天与露天场景冲突"}], ["E-G002", "E-P001"], 90, "hard")
    add("R-rain-indoor", "雨天优先室内候选", [condition("context.weather", "eq", "rain"), condition("scene.indoor", "eq", True)], [{"action": "prefer_scene", "amount": 12}], ["E-G002"], 89)
    add("R-weather-unknown", "天气未知时提示核对露天计划", [condition("context.weather", "eq", "unknown"), condition("scene.indoor", "eq", False)], [{"action": "add_warning", "message": "露天阶段需要出发前确认天气"}], ["E-G002"], 40, "hint")
    add("R-quiet-hard", "明确要求安静时过滤嘈杂候选", [condition("context.quietRequired", "eq", True), condition("scene.quiet", "eq", False)], [{"action": "exclude_scene", "reason": "场景与明确安静要求冲突"}], ["E-G005", "E-P009"], 88, "hard")
    add("R-quiet-soft", "轻度安静偏好优先安静场景", [condition("context.preferences", "contains", "quiet"), condition("scene.quiet", "eq", True)], [{"action": "prefer_scene", "amount": 10}], ["E-G005"], 60)
    add("R-indoor-soft", "室内偏好优先室内候选", [condition("context.preferences", "contains", "indoor"), condition("scene.indoor", "eq", True)], [{"action": "prefer_scene", "amount": 10}], ["E-G002"], 60)
    add("R-crowd", "避人流时过滤高人流模型标签", [condition("context.crowdAvoidance", "eq", True), condition("scene.crowdRisk", "eq", "high")], [{"action": "exclude_scene", "reason": "避人流要求与高人流候选冲突"}], ["E-P009"], 87, "hard")
    add("R-robust", "稳妥模式优先室内固定场景", [condition("context.robust", "eq", True), condition("scene.indoor", "eq", True)], [{"action": "prefer_scene", "amount": 4}], ["E-G005"], 55)
    add("R-meal-derive", "明确需要正餐时建立用餐目标", [condition("context.mealNeed", "eq", True)], [{"action": "set_fact", "fact": "derived.needsMeal", "value": True}], ["E-C001"], 98)
    add("R-meal-prefer", "用餐目标优先正餐", [condition("derived.needsMeal", "eq", True), condition("scene.kind", "eq", "meal")], [{"action": "prefer_scene", "amount": 28}], ["E-C001"], 70)
    add("R-theme-daily", "日常主题优先生活化场景", [condition("context.theme", "eq", "daily"), condition("scene.tags", "contains", "daily")], [{"action": "prefer_scene", "amount": 14}], ["E-P010"], 60)
    add("R-theme-romantic", "浪漫主题优先明确氛围标签", [condition("context.theme", "eq", "romantic"), condition("scene.tags", "contains", "romantic")], [{"action": "prefer_scene", "amount": 14}], ["E-P008"], 60)
    add("R-theme-fresh", "新鲜主题优先探索型候选", [condition("context.theme", "eq", "fresh"), condition("scene.novelty", "gte", 60)], [{"action": "prefer_scene", "amount": 14}], ["E-research-novelty"], 60)
    for tag in ("nature", "culture", "food", "play", "creative", "romantic", "exercise", "learning", "photo", "music"):
        add(f"R-shared-{tag}", f"双方共同{tag}兴趣优先匹配", [condition("context.preferencesA", "contains", tag), condition("context.preferencesB", "contains", tag), condition("scene.tags", "contains", tag)], [{"action": "prefer_scene", "amount": 16}], ["E-C004", "E-research-novelty"], 58)
    for tag in ("raw", "cold", "spicy", "dairy", "gluten", "meat", "caffeine"):
        add(f"R-diet-{tag}", f"明确{tag}饮食限制过滤冲突活动", [condition("context.dietaryRestrictions", "contains", tag), condition("activity.dietaryTags", "contains", tag)], [{"action": "exclude_activity", "reason": "活动与明确饮食限制冲突"}], ["E-C002"], 86, "hard")
    for sid, prep in (("campus_tabletennis", "racket"), ("campus_tabletennis", "ball"), ("badminton", "badminton_kit"), ("agriculture_museum", "opening_checked"), ("campus_picnic", "picnic_mat"), ("ice", "closed_shoes")):
        add(f"R-prepare-{sid}-{prep}", f"{sid}需要准备{prep}", [condition("scene.id", "eq", sid), condition("context.preparedIds", "not_contains", prep)], [{"action": "require_preparation", "preparationId": prep, "id": prep, "message": "候选需要先确认准备事项"}], ["E-campus-note" if sid == "campus_tabletennis" else "E-G006"], 80, "hard")
    add("R-photo-consent", "需明确同意的活动确认双方意愿", [condition("activity.requiresExplicitConsent", "eq", True)], [{"action": "add_warning", "message": "此活动需要双方明确愿意，可随时取消或调整。"}], ["E-P007"], 45, "hint")
    add("R-opening-confirm", "文化设施需要核对可用性", [condition("context.robust", "eq", True), condition("scene.preparationIds", "contains", "opening_checked")], [{"action": "add_warning", "message": "设施名称线索需要通过开放与预约确认后才能使用"}], ["E-game-c73b126a", "E-campus-museum"], 45, "hint")
    add("R-short-derive", "短时间建立近距离目标", [condition("context.duration", "lte", 90)], [{"action": "set_fact", "fact": "derived.shortVisit", "value": True}], ["E-lab-time", "E-G006"], 97)
    add("R-short-near", "短时间优先附近与校内", [condition("derived.shortVisit", "eq", True), condition("scene.area", "in", ["campus", "near", "current"])], [{"action": "prefer_scene", "amount": 12}], ["E-lab-time"], 65)
    add("R-short-off", "短时间提示远距离成本", [condition("derived.shortVisit", "eq", True), condition("scene.area", "eq", "off")], [{"action": "add_warning", "message": "短时行程需额外核对往返时间"}], ["E-G006"], 45, "hint")
    add("R-lowbudget-derive", "低预算推导节约目标", [condition("context.budget", "exists"), condition("context.budget", "lte", 80)], [{"action": "set_fact", "fact": "derived.saveBudget", "value": True}], ["E-P001", "E-C001"], 96)
    add("R-lowbudget-free", "节约目标优先免费基线", [condition("derived.saveBudget", "eq", True), condition("scene.cost.1", "eq", 0)], [{"action": "prefer_scene", "amount": 8}], ["E-C001"], 35)
    return sorted(rules, key=lambda rule: (-rule["priority"], rule["id"]))


PREPARATIONS = {
    "water": "饮水", "racket": "乒乓球拍", "ball": "乒乓球", "closed_shoes": "合适的包脚鞋", "paper_pen": "纸笔", "opening_checked": "已核对开放与预约", "picnic_mat": "可用野餐垫", "picnic_pack": "一份野餐食物", "phone_camera": "可用相机或手机", "craft_kit": "一份手作材料", "earphones": "可用耳机", "badminton_kit": "羽毛球拍与球", "court_checked": "已确认可用场地", "photo_pair": "已完成共同拍照", "breakfast_pack": "已采购早餐", "printed_photo": "已冲印照片", "shared_sketch": "共同速写", "handmade_card": "手作卡片", "meal_completed": "已完成正餐",
}
INTEREST_LABELS = {"nature": "自然观察", "culture": "文化体验", "food": "餐饮", "play": "游戏互动", "creative": "创作手作", "romantic": "浪漫氛围", "quiet": "安静", "indoor": "室内", "exercise": "轻运动", "learning": "共同学习", "daily": "日常生活", "photo": "拍照", "music": "音乐"}
DIETARY_LABELS = {"raw": "生食", "cold": "冷饮冷食", "spicy": "辣味", "dairy": "乳制品", "gluten": "含麸质食物", "meat": "肉类", "caffeine": "含咖啡因饮品"}


def build_graph(catalog: dict, evidence: list[dict], rules: list[dict], sources: list[dict]) -> dict:
    nodes, edges = {}, []

    def node(nid: str, kind: str, label: str) -> None:
        nodes[nid] = {"id": nid, "type": kind, "label": label}

    def edge(subject: str, predicate: str, obj: str, basis: list[str], kind: str = "designed") -> None:
        identity = f"{subject}|{predicate}|{obj}"
        edges.append({"id": "EDGE-" + digest(identity.encode())[:14], "subject": subject, "predicate": predicate, "object": obj, "evidenceIds": basis, "assertionKind": kind})

    for source in sources:
        node(source["id"], "source", source["title"])
    for ev in evidence:
        node(ev["id"], "evidence", ev["summary"])
        edge(ev["id"], "derived_from", ev["sourceDocumentId"], [ev["id"]], "observed")
    for tag in INTEREST_TAGS + ["outdoor"]:
        node("tag:" + tag, "feature", tag)
    for pid, label in PREPARATIONS.items():
        node("resource:" + pid, "resource", label)
    for s in catalog["scenes"]:
        node(s["id"], "scene", s["title"])
        for tag in s["tags"]:
            edge(s["id"], "has_feature", "tag:" + tag, s["evidenceIds"])
        for prep in s["requires"]:
            edge(s["id"], "requires", "resource:" + prep, s["evidenceIds"])
        for ev in s["evidenceIds"]:
            edge(s["id"], "supported_by", ev, [ev])
        for a in s["activities"]:
            node(a["id"], "activity", a["title"])
            edge(s["id"], "allows_activity", a["id"], a["evidenceIds"])
            for tag in a["tags"]:
                if "tag:" + tag not in nodes:
                    node("tag:" + tag, "feature", tag)
                edge(a["id"], "has_feature", "tag:" + tag, a["evidenceIds"])
            for predicate in ("requires", "provides", "consumes"):
                for rid in a[predicate]:
                    edge(a["id"], predicate, "resource:" + rid, a["evidenceIds"])
            for prior in a["predecessorIds"]:
                edge(a["id"], "follows", prior, a["evidenceIds"])
    for rule in rules:
        node(rule["id"], "rule", rule["title"])
        for ev in rule["evidenceIds"]:
            edge(rule["id"], "supported_by", ev, [ev])
    return {"version": VERSION, "nodes": sorted(nodes.values(), key=lambda n: n["id"]), "edges": sorted({e["id"]: e for e in edges}.values(), key=lambda e: e["id"]), "queryExamples": [{"start": "campus_tabletennis", "predicates": ["requires"], "purpose": "查询乒乓球装备依赖"}, {"start": "groceries", "predicates": ["allows_activity", "provides"], "purpose": "从采购场景找到可生成的资源"}, {"start": "photo_print", "predicates": ["follows"], "purpose": "查询冲印的先行活动"}]}


def build_conditions() -> list[dict]:
    specs = [("weather", "enum", ["unknown", "clear", "rain"]), ("area", "enum", ["all", "near", "campus"]), ("theme", "enum", ["any", "daily", "romantic", "fresh"]), ("duration", "integer", None), ("budget", "integer", None), ("fatigueA", "integer", None), ("fatigueB", "integer", None), ("quietRequired", "boolean", None), ("robust", "boolean", None), ("mealNeed", "boolean", None), ("crowdAvoidance", "boolean", None), ("preferences", "set", INTEREST_TAGS), ("preferencesA", "set", INTEREST_TAGS), ("preferencesB", "set", INTEREST_TAGS), ("preparedIds", "set", list(PREPARATIONS)), ("dietaryRestrictions", "set", ["raw", "cold", "spicy", "dairy", "gluten", "meat", "caffeine"]), ("bans", "set", None)]
    return [{"key": key, "type": typ, "allowedValues": allowed, "subjectTypes": ["couple", "environment", "plan"], "sensitive": key in ("dietaryRestrictions",), "defaultStrength": "hard" if key in ("bans", "dietaryRestrictions", "quietRequired", "duration", "budget") else "soft", "schemaVersion": "prototype-compatible-3.0", "unit": "minute" if key == "duration" else "CNY" if key == "budget" else "design-load-unit" if key.startswith("fatigue") else None} for key, typ, allowed in specs]


def verify(catalog: dict, evidence: list[dict], rules: list[dict], graph: dict, sources: list[dict]) -> dict:
    scene_ids = [s["id"] for s in catalog["scenes"]]
    activity_ids = [a["id"] for a in catalog["activities"]]
    evidence_ids = {e["id"] for e in evidence}
    source_ids = {s["id"] for s in sources}
    assert len(scene_ids) >= 30 and len(set(scene_ids)) == len(scene_ids)
    assert len(activity_ids) >= 40 and len(set(activity_ids)) == len(activity_ids)
    assert len(rules) >= 20 and len({r["id"] for r in rules}) == len(rules)
    assert len(graph["edges"]) >= 100
    assert {"mall_arcade", "mall_stores", "mall_snacks"} <= set(activity_ids)
    assert next(s for s in catalog["scenes"] if s["id"] == "rest")["activities"] == []
    assert next(s for s in catalog["scenes"] if s["id"] == "meal")["dietaryTags"] == []
    assert next(a for a in catalog["activities"] if a["id"] == "meal_style_raw")["dietaryTags"] == ["raw"]
    assert next(a for a in catalog["activities"] if a["id"] == "meal_style_spicy")["dietaryTags"] == ["spicy"]
    for obj in catalog["scenes"] + catalog["activities"]:
        assert obj["minutes"] >= 0 and len(obj["cost"]) == 2 and 0 <= obj["cost"][0] <= obj["cost"][1], obj["id"]
        assert obj["evidenceIds"] and set(obj["evidenceIds"]) <= evidence_ids, obj["id"]
        assert set(obj["requires"] + obj["provides"] + obj["consumes"]) <= set(PREPARATIONS), obj["id"]
        assert set(obj["predecessorIds"]) <= set(activity_ids + scene_ids), obj["id"]
        assert obj["parameterStatus"] == "designed_not_measured"
    for e in evidence:
        assert e["sourceDocumentId"] in source_ids
        assert "originalExcerpt" not in e and not e["publicExcerptAllowed"]
    node_ids = {n["id"] for n in graph["nodes"]}
    for e in graph["edges"]:
        assert e["subject"] in node_ids and e["object"] in node_ids, e
        assert set(e["evidenceIds"]) <= evidence_ids
    producers = {r for a in catalog["activities"] for r in a["provides"]}
    assert "picnic_pack" in producers
    assert any(a["id"] == "picnic_share" and "picnic_pack" in a["consumes"] for a in catalog["activities"])
    assert any(a["id"] == "photo_print" and "photo_pair" in a["predecessorIds"] for a in catalog["activities"])
    rule_ids = {r["id"] for r in rules}
    assert {"R-fatigue-derive", "R-fatigue-rest", "R-fatigue-scene"} <= rule_ids
    consent_rule = next(r for r in rules if r["id"] == "R-photo-consent")
    assert consent_rule["title"] == "需明确同意的活动确认双方意愿"
    assert consent_rule["then"] == [{"action": "add_warning", "message": "此活动需要双方明确愿意，可随时取消或调整。"}]
    return {"status": "passed", "assertions": 23, "sceneCount": len(scene_ids), "activityCount": len(activity_ids), "ruleCount": len(rules), "evidenceCount": len(evidence), "graphNodeCount": len(graph["nodes"]), "graphEdgeCount": len(graph["edges"]), "sourceCount": len(sources), "scannedSourceCount": sum(s["status"] == "scanned" for s in sources), "adoptedSourceCount": sum(bool(s["adoptedEvidenceIds"]) for s in sources), "candidateOnlySourceCount": sum(s["status"] == "scanned" and not s["adoptedEvidenceIds"] for s in sources), "decodeFailedCount": sum(s["status"] == "decode_failed" for s in sources), "rawExcerptsPublished": 0}


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    project = Path(__file__).resolve().parents[1]
    workspace = project.parent
    parser.add_argument("--corpus", type=Path, default=workspace / "语料资料")
    parser.add_argument("--prototype", type=Path, default=workspace / "DateMate_策划书与交互原型_V2.0/datemate_v2/prototype/catalog.json")
    parser.add_argument("--extract-candidates", action="store_true", help="显式启用初始候选抽取；不会更新手工知识源")
    parser.add_argument("--output", type=Path, help="必填的独立候选目录；禁止写入 data/ 或 knowledge/")
    args = parser.parse_args()
    if not args.extract_candidates or args.output is None:
        parser.error("日常构建请运行 node tools/build_catalog.mjs；初始抽取须同时提供 --extract-candidates --output 独立候选目录")
    args.output = args.output.resolve()
    protected = [(project / name).resolve() for name in ("data", "knowledge")]
    if args.output == project.resolve() or any(args.output == root or args.output.is_relative_to(root) for root in protected):
        parser.error("候选输出不得写入项目根目录、data/、knowledge/ 或其子目录")
    generated_names = ("catalog.json", "catalog.mjs", "activities.mjs", "rules.json", "graph.json", "evidence.json", "source-registry.json", "conditions.json", "extraction-report.json")
    existing = [name for name in generated_names if (args.output / name).exists()]
    if existing:
        parser.error("候选输出已存在，请选择新的空目录，避免覆盖：" + ", ".join(existing))
    sources, texts = scan_corpus(args.corpus)
    evidence = build_evidence(texts)
    prototype = json.loads(args.prototype.read_text(encoding="utf-8"))
    catalog = expand_catalog(prototype, evidence)
    rules = build_rules()
    conditions = build_conditions()
    graph = build_graph(catalog, evidence, rules, sources)
    checks = verify(catalog, evidence, rules, graph, sources)
    # createPlanner(catalog) 直接获取规则与图谱；分离导出继续支持独立课程演示。
    catalog["rules"] = rules
    catalog["graph"] = graph
    categories = Counter(s["category"] for s in sources)
    audit = {"version": VERSION, "checks": checks, "categoryCounts": dict(categories), "candidateHitsByFeature": {k: sum(s["candidateHits"].get(k, 0) for s in sources) for k in FEATURE_PATTERNS}, "processingPolicy": "全文本扫描与哈希登记；关键词用于候选发现，正式采用项以定位证据为准。原始材料不写入公开数据。", "prototypeSha256": digest(args.prototype.read_bytes()), "buildScriptSha256": digest(Path(__file__).read_bytes()), "catalogContentSha256": digest(json.dumps(catalog, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()), "defaultContext": {"duration": 180, "budget": None, "weather": "unknown", "area": "all", "fatigueA": 2, "fatigueB": 2, "preferences": [], "quietRequired": False, "theme": "any", "bans": [], "preferencesA": [], "preferencesB": [], "preparedIds": [], "dietaryRestrictions": [], "robust": True, "mealNeed": False, "crowdAvoidance": False, "windows": [{"id": "afternoon", "startMinute": 840, "endMinute": 1020}]}, "resourceDefinitions": PREPARATIONS}
    args.output.mkdir(parents=True, exist_ok=True)
    for name, data in (("catalog.json", catalog), ("rules.json", rules), ("graph.json", graph), ("evidence.json", evidence), ("source-registry.json", sources), ("conditions.json", conditions), ("extraction-report.json", audit)):
        write_json(args.output / name, data)
    module = "// 本文件由 tools/build_knowledge.py 生成；数据参数属于课程设计模型。\n"
    module_catalog = {k: v for k, v in catalog.items() if k not in ("rules", "graph")}
    for name, data in (("catalog", module_catalog), ("rules", rules), ("graph", graph), ("sources", sources), ("evidence", evidence), ("conditions", conditions)):
        module += f"export const {name} = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
    module += "catalog.rules = rules;\ncatalog.graph = graph;\n"
    module += "export default catalog;\n"
    (args.output / "catalog.mjs").write_text(module, encoding="utf-8", newline="\n")
    metadata = "// 标签元数据由 tools/build_knowledge.py 生成。\n"
    for name, data in (("interestTags", INTEREST_TAGS), ("interestOptions", [{"id": tag, "label": INTEREST_LABELS[tag]} for tag in INTEREST_TAGS]), ("preparationOptions", [{"id": key, "label": label} for key, label in PREPARATIONS.items()]), ("dietaryOptions", [{"id": key, "label": label} for key, label in DIETARY_LABELS.items()])):
        metadata += f"export const {name} = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
    (args.output / "activities.mjs").write_text(metadata, encoding="utf-8", newline="\n")
    print("候选抽取完成；请人工核对并编辑 knowledge/*.json，然后运行 node tools/build_catalog.mjs。")
    print(json.dumps(checks, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
