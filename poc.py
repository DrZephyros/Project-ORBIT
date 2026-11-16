"""Live pose probe: record fist vs scroll metrics from the real hand."""
import cv2, numpy as np, mediapipe as mp, time, sys, json
from mediapipe.tasks.python import vision, BaseOptions
sys.path.insert(0, 'services/gestures')
from orbit_gestures.geometry import pose_metrics, three_finger_pinch, finger_curl

opts = vision.HandLandmarkerOptions(
    base_options=BaseOptions(model_asset_path='services/gestures/models/hand_landmarker.task'),
    running_mode=vision.RunningMode.VIDEO, num_hands=2)
lm = vision.HandLandmarker.create_from_options(opts)
cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
start = time.monotonic()
print("Hold a FIST in front, then a 3-finger SCROLL, then fist again...", flush=True)
rows = []
for _ in range(240):
    ok, f = cap.read()
    if not ok: continue
    f = cv2.flip(f, 1)
    rgb = cv2.cvtColor(f, cv2.COLOR_BGR2RGB)
    img = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
    t = int((time.monotonic()-start)*1000)
    r = lm.detect_for_video(img, t)
    if not r.hand_landmarks: continue
    hand = [(l.x,l.y,l.z) for l in r.hand_landmarks[0]]
    world = [(l.x,l.y,l.z) for l in r.hand_world_landmarks[0]]
    m = pose_metrics(hand, world)
    if not m: continue
    scroll = three_finger_pinch(hand, world_hand=world)
    rows.append({"curl": round(finger_curl(hand, world),2), "scroll": scroll, **m})
cap.release()
if rows:
    sc = [r for r in rows if r["scroll"]]
    fi = [r for r in rows if not r["scroll"]]
    def stats(name, rs):
        if not rs: print(f"{name}: none"); return
        for k in ("thumbReach","indexSpan","middleSpan","curl"):
            v=[r[k] for r in rs]
            print(f"  {name} {k}: min {min(v):.2f} max {max(v):.2f} mean {sum(v)/len(v):.2f}")
    print(f"\nframes: {len(rows)}  scroll-classified: {len(sc)}  not: {len(fi)}")
    stats("SCROLL", sc); stats("FIST  ", fi)
else:
    print("no hand detected")
