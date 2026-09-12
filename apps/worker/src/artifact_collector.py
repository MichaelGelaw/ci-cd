import glob
import logging
import mimetypes
import os
from typing import Any, Dict, List, Optional, Union
from src.api_client import ApiClient

logger = logging.getLogger("worker.artifacts")


class ArtifactCollector:
    @staticmethod
    def collect_and_upload(
        workspace_dir: str,
        artifacts_config: Union[List[str], Dict[str, Any], str],
        api_client: ApiClient,
        job_id: str,
    ) -> List[Dict[str, Any]]:
        patterns: List[str] = []

        if isinstance(artifacts_config, list):
            patterns = [str(p) for p in artifacts_config]
        elif isinstance(artifacts_config, dict):
            if "paths" in artifacts_config and isinstance(artifacts_config["paths"], list):
                patterns.extend(str(p) for p in artifacts_config["paths"])
            if "path" in artifacts_config and isinstance(artifacts_config["path"], str):
                patterns.append(artifacts_config["path"])
        elif isinstance(artifacts_config, str):
            patterns = [artifacts_config]

        uploaded: List[Dict[str, Any]] = []
        seen_files = set()

        for pattern in patterns:
            search_pattern = pattern if os.path.isabs(pattern) else os.path.join(workspace_dir, pattern)
            matches = glob.glob(search_pattern, recursive=True)

            for match in matches:
                if os.path.isdir(match):
                    for root, _, files in os.walk(match):
                        for f in files:
                            full_path = os.path.join(root, f)
                            if full_path in seen_files:
                                continue
                            seen_files.add(full_path)
                            rel_path = os.path.relpath(full_path, workspace_dir)
                            mime_type, _ = mimetypes.guess_type(full_path)
                            try:
                                res = api_client.upload_artifact(
                                    job_id=job_id,
                                    file_path=full_path,
                                    name=f,
                                    logical_path=rel_path,
                                    mime_type=mime_type,
                                )
                                uploaded.append(res.get("artifact", res))
                                logger.info(f"Uploaded artifact file {rel_path} for job {job_id}")
                            except Exception as e:
                                logger.error(f"Failed to upload artifact {rel_path} for job {job_id}: {e}")
                elif os.path.isfile(match):
                    if match in seen_files:
                        continue
                    seen_files.add(match)
                    rel_path = os.path.relpath(match, workspace_dir)
                    mime_type, _ = mimetypes.guess_type(match)
                    try:
                        res = api_client.upload_artifact(
                            job_id=job_id,
                            file_path=match,
                            name=os.path.basename(match),
                            logical_path=rel_path,
                            mime_type=mime_type,
                        )
                        uploaded.append(res.get("artifact", res))
                        logger.info(f"Uploaded artifact file {rel_path} for job {job_id}")
                    except Exception as e:
                        logger.error(f"Failed to upload artifact {rel_path} for job {job_id}: {e}")

        return uploaded