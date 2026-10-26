import argparse
import csv
import time
import json
import requests
from pathlib import Path


def timed_get(session, url, keep_body=False):
    start = time.perf_counter()

    response = session.get(url, stream=True, timeout=120)
    headers_time = time.perf_counter()

    chunks = [] if keep_body else None
    first_byte = None
    total_bytes = 0

    for chunk in response.iter_content(chunk_size=64 * 1024):
        if chunk:
            if first_byte is None:
                first_byte = time.perf_counter()

            total_bytes += len(chunk)

            if keep_body:
                chunks.append(chunk)

    end = time.perf_counter()

    if first_byte is None:
        first_byte = headers_time

    ttfb_ms = (first_byte - start) * 1000
    total_ms = (end - start) * 1000

    seconds = max(end - first_byte, 1e-9)

    throughput_mbps = (
        total_bytes * 8 / 1_000_000 / seconds
    )

    body = b"".join(chunks) if keep_body else None

    return {
        "response": response,
        "body": body,
        "status": response.status_code,
        "ttfb_ms": ttfb_ms,
        "total_ms": total_ms,
        "bytes": total_bytes,
        "throughput_mbps": throughput_mbps,
    }

def main():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--base-url",
        required=True,
        help="Ej: https://xxxx.trycloudflare.com/dicom-web",
    )

    parser.add_argument("--study", required=True)
    parser.add_argument("--series", required=True)

    parser.add_argument(
        "--runs",
        type=int,
        default=5,
    )

    parser.add_argument(
        "--output",
        default="benchmark_dicomweb.csv",
    )

    args = parser.parse_args()

    base = args.base_url.rstrip("/")

    metadata_url = (
        f"{base}/studies/{args.study}"
        f"/series/{args.series}/metadata"
    )

    session = requests.Session()

    rows = []

    for run in range(1, args.runs + 1):

        print(f"\n===== RUN {run}/{args.runs} =====")

        # ---------------------------
        # METADATA
        # ---------------------------

        result = timed_get(
            session,
            metadata_url,
            keep_body=True
        )

        print(
            f"metadata: {result['status']} | "
            f"TTFB={result['ttfb_ms']:.1f} ms | "
            f"total={result['total_ms']:.1f} ms | "
            f"{result['bytes']/1024:.1f} KB"
        )

        rows.append({
            "run": run,
            "tipo": "metadata",
            "nivel": "",
            "resolucion": "",
            "frame": "",
            "status": result["status"],
            "ttfb_ms": round(result["ttfb_ms"], 2),
            "total_ms": round(result["total_ms"], 2),
            "bytes": result["bytes"],
            "throughput_mbps": round(
                result["throughput_mbps"], 3
            ),
        })

        result["response"].raise_for_status()

        metadata = json.loads(result["body"])

        # ---------------------------
        # IDENTIFICAR NIVELES VOLUME
        # ---------------------------

        levels = []

        for item in metadata:
            image_type = (
                item.get("00080008", {})
                .get("Value", [])
            )

            if len(image_type) < 3:
                continue

            if image_type[2] != "VOLUME":
                continue

            sop = (
                item["00080018"]["Value"][0]
            )

            cols = (
                item.get("00480006", {})
                .get("Value", [0])[0]
            )

            rows_px = (
                item.get("00480007", {})
                .get("Value", [0])[0]
            )

            frames = int(
                item.get("00280008", {})
                .get("Value", [1])[0]
            )

            levels.append({
                "sop": sop,
                "cols": cols,
                "rows": rows_px,
                "frames": frames,
            })

        # Mayor resolución primero
        levels.sort(
            key=lambda x: x["cols"] * x["rows"],
            reverse=True,
        )

        print(f"Niveles VOLUME: {len(levels)}")

        # ---------------------------
        # FRAMES
        # ---------------------------

        for level_index, level in enumerate(levels):

            n = level["frames"]

            # Primer, medio y último frame
            sample_frames = sorted(
                set([
                    1,
                    max(1, (n + 1) // 2),
                    n,
                ])
            )

            for frame in sample_frames:

                frame_url = (
                    f"{base}/studies/{args.study}"
                    f"/series/{args.series}"
                    f"/instances/{level['sop']}"
                    f"/frames/{frame}"
                )

                r = timed_get(session, frame_url)

                resolution = (
                    f"{level['cols']}x{level['rows']}"
                )

                print(
                    f"L{level_index} "
                    f"{resolution} "
                    f"frame {frame}: "
                    f"{r['status']} | "
                    f"TTFB={r['ttfb_ms']:.1f} ms | "
                    f"total={r['total_ms']:.1f} ms | "
                    f"{r['bytes']/1024/1024:.2f} MB | "
                    f"{r['throughput_mbps']:.2f} Mbps"
                )

                rows.append({
                    "run": run,
                    "tipo": "frame",
                    "nivel": level_index,
                    "resolucion": resolution,
                    "frame": frame,
                    "status": r["status"],
                    "ttfb_ms": round(
                        r["ttfb_ms"], 2
                    ),
                    "total_ms": round(
                        r["total_ms"], 2
                    ),
                    "bytes": r["bytes"],
                    "throughput_mbps": round(
                        r["throughput_mbps"], 3
                    ),
                })

    output = Path(args.output)

    with output.open(
        "w",
        newline="",
        encoding="utf-8",
    ) as f:

        writer = csv.DictWriter(
            f,
            fieldnames=[
                "run",
                "tipo",
                "nivel",
                "resolucion",
                "frame",
                "status",
                "ttfb_ms",
                "total_ms",
                "bytes",
                "throughput_mbps",
            ],
        )

        writer.writeheader()
        writer.writerows(rows)

    print(f"\nCSV guardado en: {output.resolve()}")


if __name__ == "__main__":
    main()