"""
Persistent Job Store

Saves prediction jobs to disk for persistence across restarts.
Jobs are stored as JSON files with associated structure files (PDB, CIF).
"""

import json
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any
import structlog

from backend.api.models import JobResult, JobStatus, StructureResult

logger = structlog.get_logger()


class JobStore:
    """
    Persistent job store that saves jobs to disk.
    
    Directory structure:
    {storage_dir}/
      jobs/
        {job_id}/
          job.json          # Job metadata and results
          structure.pdb     # PDB structure file (if completed)
          structure.cif     # CIF structure file (if available)
          confidence.json   # Confidence scores
          attestation.json  # Attestation document
    """
    
    def __init__(self, storage_dir: str = "/opt/boltz/jobs"):
        """Initialize the job store."""
        self.storage_dir = Path(storage_dir)
        self.jobs_dir = self.storage_dir / "jobs"
        
        # Create directories
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        
        # In-memory cache for active jobs
        self._cache: Dict[str, JobResult] = {}
        
        # Load existing jobs from disk
        self._load_all_jobs()
        
        logger.info("Job store initialized", storage_dir=str(self.storage_dir), jobs_loaded=len(self._cache))
    
    def _load_all_jobs(self):
        """Load all jobs from disk into memory cache."""
        for job_dir in self.jobs_dir.iterdir():
            if job_dir.is_dir():
                try:
                    job = self._load_job_from_disk(job_dir.name)
                    if job:
                        self._cache[job_dir.name] = job
                except Exception as e:
                    logger.warning("Failed to load job", job_id=job_dir.name, error=str(e))
    
    def _load_job_from_disk(self, job_id: str) -> Optional[JobResult]:
        """Load a single job from disk."""
        job_dir = self.jobs_dir / job_id
        job_file = job_dir / "job.json"
        
        if not job_file.exists():
            return None
        
        with open(job_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        
        # Reconstruct JobResult from saved data
        structure = None
        if data.get("structure"):
            structure = StructureResult(
                pdb_string=data["structure"].get("pdb_string", ""),
                confidence_score=data["structure"].get("confidence_score", 0.0),
                per_residue_confidence=data["structure"].get("per_residue_confidence", []),
            )
        
        job = JobResult(
            job_id=data["job_id"],
            status=JobStatus(data["status"]),
            sequence=data.get("sequence", ""),
            sequence_length=data.get("sequence_length", 0),
            sequence_name=data.get("sequence_name"),
            created_at=datetime.fromisoformat(data["created_at"]),
            completed_at=datetime.fromisoformat(data["completed_at"]) if data.get("completed_at") else None,
            processing_time_seconds=data.get("processing_time_seconds"),
            error_message=data.get("error_message"),
            structure=structure,
            progress=data.get("progress", 0),
            progress_message=data.get("progress_message"),
        )
        
        return job
    
    def _save_job_to_disk(self, job: JobResult):
        """Save a job to disk."""
        job_dir = self.jobs_dir / job.job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        
        # Prepare job data for JSON serialization
        data = {
            "job_id": job.job_id,
            "status": job.status.value,
            "sequence": job.sequence,
            "sequence_length": job.sequence_length,
            "sequence_name": job.sequence_name,
            "created_at": job.created_at.isoformat(),
            "completed_at": job.completed_at.isoformat() if job.completed_at else None,
            "processing_time_seconds": job.processing_time_seconds,
            "error_message": job.error_message,
            "progress": job.progress,
            "progress_message": job.progress_message,
        }
        
        # Save structure separately if present
        if job.structure:
            data["structure"] = {
                "confidence_score": job.structure.confidence_score,
                "per_residue_confidence": job.structure.per_residue_confidence,
                "pdb_string": job.structure.pdb_string,
            }
            
            # Save PDB file separately for easy access
            pdb_file = job_dir / "structure.pdb"
            with open(pdb_file, "w", encoding="utf-8") as f:
                f.write(job.structure.pdb_string)
            
            # Save confidence scores separately
            conf_file = job_dir / "confidence.json"
            with open(conf_file, "w", encoding="utf-8") as f:
                json.dump({
                    "confidence_score": job.structure.confidence_score,
                    "per_residue_confidence": job.structure.per_residue_confidence,
                }, f, indent=2)
        
        # Save job metadata
        job_file = job_dir / "job.json"
        with open(job_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        
        logger.debug("Saved job to disk", job_id=job.job_id, status=job.status.value)
    
    def create_job(self, job: JobResult) -> JobResult:
        """Create a new job."""
        self._cache[job.job_id] = job
        self._save_job_to_disk(job)
        return job
    
    def get_job(self, job_id: str) -> Optional[JobResult]:
        """Get a job by ID.

        Falls back to disk if the job isn't in the in-memory cache. The background
        prediction task and the request that reads /results can run in contexts where
        the cache isn't shared (e.g. the job was persisted to disk but this cache
        doesn't have it yet), which surfaced as /results/{id} returning 404 for a job
        that /jobs listed. Reading from disk on a miss makes the lookup authoritative
        and repopulates the cache.
        """
        job = self._cache.get(job_id)
        if job is not None:
            return job
        # Cache miss: try disk (job.json under jobs/<job_id>/).
        try:
            job = self._load_job_from_disk(job_id)
        except Exception as e:
            logger.warning("Failed to load job from disk on cache miss", job_id=job_id, error=str(e))
            job = None
        if job is not None:
            self._cache[job_id] = job
        return job
    
    def update_job(self, job: JobResult):
        """Update an existing job."""
        self._cache[job.job_id] = job
        self._save_job_to_disk(job)
    
    def delete_job(self, job_id: str) -> bool:
        """Delete a job and its files."""
        if job_id not in self._cache:
            return False
        
        # Remove from cache
        del self._cache[job_id]
        
        # Remove from disk
        job_dir = self.jobs_dir / job_id
        if job_dir.exists():
            shutil.rmtree(job_dir)
        
        logger.info("Deleted job", job_id=job_id)
        return True
    
    def list_jobs(
        self,
        status: Optional[JobStatus] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[JobResult]:
        """List jobs, optionally filtered by status."""
        # Reconcile the cache with disk so the list reflects any jobs persisted by a
        # background task (or a prior process) that the cache hasn't seen — keeping
        # /jobs and /results/{id} consistent.
        try:
            self._load_all_jobs()
        except Exception as e:
            logger.warning("Failed to reconcile jobs from disk", error=str(e))
        jobs = list(self._cache.values())

        if status:
            jobs = [j for j in jobs if j.status == status]
        
        # Sort by creation time, newest first
        jobs.sort(key=lambda x: x.created_at, reverse=True)
        
        return jobs[offset:offset + limit]
    
    def get_job_count(self, status: Optional[JobStatus] = None) -> int:
        """Get total job count, optionally filtered by status."""
        if status:
            return sum(1 for j in self._cache.values() if j.status == status)
        return len(self._cache)
    
    def get_job_files(self, job_id: str) -> Dict[str, Optional[str]]:
        """Get paths to job-related files."""
        job_dir = self.jobs_dir / job_id
        
        files = {
            "pdb": None,
            "cif": None,
            "confidence": None,
            "job_metadata": None,
            "attestation": None,
        }
        
        if job_dir.exists():
            pdb_file = job_dir / "structure.pdb"
            cif_file = job_dir / "structure.cif"
            conf_file = job_dir / "confidence.json"
            job_file = job_dir / "job.json"
            attest_file = job_dir / "attestation.json"
            
            if pdb_file.exists():
                files["pdb"] = str(pdb_file)
            if cif_file.exists():
                files["cif"] = str(cif_file)
            if conf_file.exists():
                files["confidence"] = str(conf_file)
            if job_file.exists():
                files["job_metadata"] = str(job_file)
            if attest_file.exists():
                files["attestation"] = str(attest_file)
        
        return files
    
    def get_pdb_content(self, job_id: str) -> Optional[str]:
        """Get PDB content for a job."""
        job = self.get_job(job_id)
        if job and job.structure:
            return job.structure.pdb_string
        
        # Try reading from file
        pdb_file = self.jobs_dir / job_id / "structure.pdb"
        if pdb_file.exists():
            with open(pdb_file, "r", encoding="utf-8") as f:
                return f.read()
        
        return None
    
    def save_attestation(self, job_id: str, attestation: dict):
        """Save attestation document for a job."""
        job_dir = self.jobs_dir / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        
        attest_file = job_dir / "attestation.json"
        with open(attest_file, "w", encoding="utf-8") as f:
            json.dump(attestation, f, indent=2, default=str)