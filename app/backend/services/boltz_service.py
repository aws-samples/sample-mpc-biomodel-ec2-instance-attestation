"""
Boltz Model Service

Wrapper for the Boltz protein structure prediction model.
Runs the actual Boltz CLI tool (https://github.com/jwohlwend/boltz) for predictions.

Boltz is baked into the AMI at build time - this service assumes it's always available.
If boltz CLI fails, the prediction returns a clear error message.
"""

import asyncio
import os
import shutil
import subprocess  # nosec B404 - used only with fixed argv, no shell
import hashlib
from pathlib import Path
from typing import Dict, List, Optional, Any
import structlog

from backend.api.models import StructureResult, AtomCoordinate

logger = structlog.get_logger()

# Accelerator values accepted by the Boltz CLI. Used to validate the caller-supplied
# `options["accelerator"]` before it is placed in argv (see _run_boltz_cli).
_ALLOWED_ACCELERATORS = frozenset({"gpu", "cpu", "tpu"})


class BoltzPredictionError(Exception):
    """Raised when Boltz prediction fails."""
    pass


class BoltzService:
    """
    Service for running Boltz protein structure predictions.
    
    This service wraps the Boltz CLI tool (https://github.com/jwohlwend/boltz)
    and provides async inference capabilities.
    
    Boltz is baked into the AMI at build time via kiwi-ng packaging.
    No runtime availability checks - predictions fail with clear errors if something is wrong.
    """
    
    def __init__(
        self,
        cache_dir: str = "/opt/boltz/cache",
        output_dir: str = "/opt/boltz/predictions",
        use_msa_server: bool = True,
        use_potentials: bool = True,
        accelerator: str = "gpu",
        recycling_steps: int = 3,
        sampling_steps: int = 200,
        diffusion_samples: int = 1,
    ):
        """
        Initialize the Boltz service.
        
        Args:
            cache_dir: Directory for Boltz model cache
            output_dir: Directory for prediction outputs
            use_msa_server: Use MSA server for sequence alignments
            use_potentials: Use inference-time potentials for better poses
            accelerator: Device to use (gpu, cpu, tpu)
            recycling_steps: Number of recycling steps
            sampling_steps: Number of sampling/diffusion steps
            diffusion_samples: Number of structure samples to generate
        """
        self.cache_dir = Path(cache_dir)
        self.output_dir = Path(output_dir)
        self.use_msa_server = use_msa_server
        self.use_potentials = use_potentials
        self.accelerator = accelerator
        self.recycling_steps = recycling_steps
        self.sampling_steps = sampling_steps
        self.diffusion_samples = diffusion_samples
        
        self._init_service()
    
    def _init_service(self):
        """Initialize the Boltz service directories."""
        try:
            # Create cache and output directories
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self.output_dir.mkdir(parents=True, exist_ok=True)
            
            logger.info(
                "Boltz service initialized",
                cache_dir=str(self.cache_dir),
                output_dir=str(self.output_dir),
                accelerator=self.accelerator,
            )
                
        except Exception as e:
            # Error IS handled: logged and re-raised to the caller.
            logger.error("Failed to initialize Boltz service", error=str(e))  # nosemgrep: logging-error-without-handling
            raise
    
    def is_available(self) -> bool:
        """
        Check if Boltz is available for predictions.
        
        Since Boltz is baked into the AMI at build time, this always returns True.
        Actual failures (if any) will be caught during prediction with clear error messages.
        """
        return True
    
    async def predict(
        self,
        sequence: str,
        options: Optional[Dict[str, Any]] = None,
    ) -> StructureResult:
        """
        Predict protein structure from amino acid sequence.
        
        Args:
            sequence: Amino acid sequence in single-letter code
            options: Optional prediction parameters:
                - name: Optional name for the sequence
                - sequence_type: 'protein', 'dna', or 'rna'
                - recycling_steps: Override default recycling steps
                - sampling_steps: Override default sampling steps
                - diffusion_samples: Number of samples to generate
                - use_potentials: Override default use_potentials
                - include_coordinates: Parse and include atom coordinates
                
        Returns:
            StructureResult with predicted structure and confidence scores
            
        Raises:
            BoltzPredictionError: If prediction fails
        """
        options = options or {}
        
        logger.info(
            "Running Boltz prediction",
            sequence_length=len(sequence),
            options=options,
        )
        
        # Run prediction in thread pool to avoid blocking
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            self._run_prediction_sync,
            sequence,
            options,
        )
        
        return result
    
    def _run_prediction_sync(
        self,
        sequence: str,
        options: Dict[str, Any],
    ) -> StructureResult:
        """
        Synchronous prediction implementation using Boltz CLI.
        """
        # Create a unique job directory
        job_id = hashlib.sha256(sequence.encode()).hexdigest()[:16]
        job_dir = self.output_dir / job_id
        
        try:
            # Create job directory
            job_dir.mkdir(parents=True, exist_ok=True)
            
            # Create input YAML file
            input_file = self._create_input_yaml(job_dir, sequence, options)
            
            # Run Boltz prediction
            self._run_boltz_cli(input_file, job_dir, options)
            
            # Parse output
            result = self._parse_prediction_output(job_dir, sequence, options)
            
            return result
            
        except Exception as e:
            logger.error("Boltz prediction failed", error=str(e), job_id=job_id)
            raise BoltzPredictionError(f"Prediction failed: {str(e)}")
        
        finally:
            # Optionally clean up job directory
            if options.get("cleanup", False) and job_dir.exists():
                shutil.rmtree(job_dir, ignore_errors=True)
    
    def _create_input_yaml(
        self,
        job_dir: Path,
        sequence: str,
        options: Dict[str, Any],
    ) -> Path:
        """
        Create Boltz input YAML file.
        
        Boltz YAML format:
        version: 1
        sequences:
          - protein:
              id: A
              sequence: <sequence>
        """
        import yaml
        
        sequence_type = options.get("sequence_type", "protein")
        chain_id = options.get("chain_id", "A")
        name = options.get("name", "prediction")

        # When the MSA server is disabled (offline/attested instance, no internet),
        # Boltz will NOT auto-generate an alignment and errors out ("Missing MSA's in
        # input and --use_msa_server flag not set") unless the protein entry explicitly
        # opts into single-sequence mode via `msa: empty`. Set it so folding runs
        # offline (accuracy is lower without an MSA — expected tradeoff).
        use_msa = options.get("use_msa_server", self.use_msa_server)
        empty_msa = not use_msa

        # Build input structure
        input_data = {
            "version": 1,
            "sequences": []
        }

        # Add sequence based on type
        if sequence_type == "dna":
            entity = {"id": chain_id, "sequence": sequence}
            seq_entry = {"dna": entity}
        elif sequence_type == "rna":
            entity = {"id": chain_id, "sequence": sequence}
            seq_entry = {"rna": entity}
        else:  # protein (default)
            entity = {"id": chain_id, "sequence": sequence}
            # `msa: empty` is only valid/relevant for protein chains.
            if empty_msa:
                entity["msa"] = "empty"
            seq_entry = {"protein": entity}

        input_data["sequences"].append(seq_entry)
        
        # Write YAML file
        input_file = job_dir / f"{name}.yaml"
        with open(input_file, "w", encoding="utf-8") as f:
            yaml.dump(input_data, f, default_flow_style=False)
        
        logger.info("Created Boltz input file", path=str(input_file))
        
        return input_file
    
    def _run_boltz_cli(
        self,
        input_file: Path,
        job_dir: Path,
        options: Dict[str, Any],
    ):
        """
        Run the Boltz CLI predict command.
        """
        # Validate the caller-supplied options before they reach argv.
        #
        # `options` originates from PredictionRequest.options, which is an unconstrained
        # Dict[str, Any] straight off the API, so these values ARE externally controlled.
        # subprocess is invoked with shell=False, so a hostile value cannot inject a shell
        # command, but it could still smuggle an extra boltz flag (an argument starting
        # with "-") or an unbounded step count that pins the GPU. Constrain both here so
        # only known-good values are ever passed.
        accelerator = str(options.get("accelerator", self.accelerator))
        if accelerator not in _ALLOWED_ACCELERATORS:
            raise ValueError(
                f"Invalid accelerator {accelerator!r}; expected one of "
                f"{sorted(_ALLOWED_ACCELERATORS)}"
            )

        def _bounded_int(key: str, default: int, low: int, high: int) -> int:
            try:
                value = int(options.get(key, default))
            except (TypeError, ValueError):
                raise ValueError(f"Option {key!r} must be an integer") from None
            if not low <= value <= high:
                raise ValueError(f"Option {key!r} must be between {low} and {high}")
            return value

        recycling_steps = _bounded_int("recycling_steps", self.recycling_steps, 1, 10)
        sampling_steps = _bounded_int("sampling_steps", self.sampling_steps, 1, 1000)
        diffusion_samples = _bounded_int("diffusion_samples", self.diffusion_samples, 1, 25)

        # Build command
        cmd = [
            "boltz", "predict",
            str(input_file),
            "--out_dir", str(job_dir),
            "--cache", str(self.cache_dir),
            "--accelerator", accelerator,
            "--recycling_steps", str(recycling_steps),
            "--sampling_steps", str(sampling_steps),
            "--diffusion_samples", str(diffusion_samples),
            "--override",  # Always run fresh prediction
        ]

        # Add optional flags
        if options.get("use_msa_server", self.use_msa_server):
            cmd.append("--use_msa_server")
        
        # Output format as PDB for easier parsing
        cmd.extend(["--output_format", "pdb"])
        
        logger.info("Running Boltz CLI", command=" ".join(cmd))
        
        # Set environment variables
        env = os.environ.copy()
        env["BOLTZ_CACHE"] = str(self.cache_dir)
        
        # Run prediction.
        #
        # `cmd` is not a static string, but every element is either a literal, a path this
        # service generated, or one of the option values validated above against an
        # allowlist / numeric bound. shell=False, so no shell metacharacter interpretation.
        try:
            # nosemgrep: dangerous-subprocess-use-audit
            result = subprocess.run(  # nosec B603 - argv is literals, our own paths, and validated options; no shell
                cmd,
                capture_output=True,
                text=True,
                timeout=3600,  # 1 hour timeout
                env=env,
            )
            
            if result.returncode != 0:
                logger.error(
                    "Boltz CLI failed",
                    stdout=result.stdout,
                    stderr=result.stderr,
                    returncode=result.returncode
                )
                raise BoltzPredictionError(
                    f"Boltz prediction failed: {result.stderr or result.stdout}"
                )
            
            logger.info("Boltz prediction completed", stdout=result.stdout[:500] if result.stdout else "")
            
        except FileNotFoundError:
            raise BoltzPredictionError(
                "Boltz CLI not found. This AMI may be corrupted - boltz should be pre-installed."
            )
        except subprocess.TimeoutExpired:
            raise BoltzPredictionError("Boltz prediction timed out (>1 hour)")
    
    def _parse_prediction_output(
        self,
        job_dir: Path,
        sequence: str,
        options: Dict[str, Any],
    ) -> StructureResult:
        """
        Parse Boltz prediction output files.
        
        Boltz outputs:
        - boltz_results_<name>/predictions/<name>/<name>_model_0.pdb
        - boltz_results_<name>/predictions/<name>/confidence_<name>_model_0.json
        """
        name = options.get("name", "prediction")
        
        # Find output files - Boltz creates complex nested structure
        predictions_dir = None
        
        # Try various path patterns
        possible_paths = [
            job_dir / f"boltz_results_{name}" / "predictions" / name,
            job_dir / name / "predictions" / name,
            job_dir / "predictions" / name,
        ]
        
        for path in possible_paths:
            if path.exists():
                predictions_dir = path
                break
        
        # If not found, search recursively for any structure file
        if predictions_dir is None:
            pdb_files = list(job_dir.rglob("*_model_0.pdb"))
            cif_files = list(job_dir.rglob("*_model_0.cif"))
            
            if pdb_files:
                predictions_dir = pdb_files[0].parent
            elif cif_files:
                predictions_dir = cif_files[0].parent
            else:
                # Last resort: find any .pdb or .cif
                pdb_files = list(job_dir.rglob("*.pdb"))
                cif_files = list(job_dir.rglob("*.cif"))
                if pdb_files:
                    predictions_dir = pdb_files[0].parent
                elif cif_files:
                    predictions_dir = cif_files[0].parent
                else:
                    raise BoltzPredictionError(
                        f"No prediction output found in {job_dir}"
                    )
        
        logger.info("Found predictions directory", path=str(predictions_dir))
        
        # Find structure file (prefer PDB, fall back to CIF)
        pdb_file = predictions_dir / f"{name}_model_0.pdb"
        cif_file = predictions_dir / f"{name}_model_0.cif"
        
        if cif_file.exists():
            structure_file = cif_file
            pdb_string = self._convert_cif_to_pdb(cif_file)
        elif pdb_file.exists():
            structure_file = pdb_file
            with open(pdb_file, "r", encoding="utf-8") as f:
                pdb_string = f.read()
        else:
            # Find any structure file
            cif_files = list(predictions_dir.glob("*.cif"))
            pdb_files = list(predictions_dir.glob("*.pdb"))
            
            if cif_files:
                structure_file = cif_files[0]
                pdb_string = self._convert_cif_to_pdb(structure_file)
            elif pdb_files:
                structure_file = pdb_files[0]
                with open(structure_file, "r", encoding="utf-8") as f:
                    pdb_string = f.read()
            else:
                raise BoltzPredictionError(
                    f"No structure file found in {predictions_dir}"
                )
        
        logger.info("Found structure file", path=str(structure_file))
        
        # Parse confidence scores
        confidence_file = predictions_dir / "confidence_model_0.json"
        confidence_score, per_residue_confidence = self._parse_confidence(
            confidence_file, len(sequence)
        )
        
        # Parse coordinates if requested
        coordinates = None
        if options.get("include_coordinates", False):
            coordinates = self._parse_pdb_coordinates(pdb_string)
        
        return StructureResult(
            pdb_string=pdb_string,
            confidence_score=confidence_score,
            per_residue_confidence=per_residue_confidence,
            coordinates=coordinates,
        )
    
    def _convert_cif_to_pdb(self, cif_file: Path) -> str:
        """Convert mmCIF file to PDB format using BioPython."""
        try:
            from Bio.PDB import MMCIFParser, PDBIO
            import io
            
            parser = MMCIFParser(QUIET=True)
            structure = parser.get_structure("structure", str(cif_file))
            
            pdb_io = PDBIO()
            pdb_io.set_structure(structure)
            
            output = io.StringIO()
            pdb_io.save(output)
            
            return output.getvalue()
            
        except ImportError:
            logger.warning("BioPython not available, reading CIF as-is")
            with open(cif_file, "r", encoding="utf-8") as f:
                return f.read()
        except Exception as e:
            logger.warning("CIF to PDB conversion failed", error=str(e))
            with open(cif_file, "r", encoding="utf-8") as f:
                return f.read()
    
    def _parse_confidence(
        self,
        confidence_file: Path,
        sequence_length: int,
    ) -> tuple:
        """Parse confidence scores from Boltz output."""
        import json
        
        if confidence_file.exists():
            try:
                with open(confidence_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                
                per_residue = None
                overall = None
                
                if "plddt" in data:
                    per_residue = data["plddt"]
                elif "per_residue_plddt" in data:
                    per_residue = data["per_residue_plddt"]
                elif "confidence" in data:
                    per_residue = data["confidence"]
                
                if "mean_plddt" in data:
                    overall = data["mean_plddt"] / 100.0
                elif "overall_confidence" in data:
                    overall = data["overall_confidence"]
                elif "ptm" in data:
                    overall = data["ptm"]
                
                if per_residue:
                    if any(v > 1 for v in per_residue):
                        per_residue = [v / 100.0 for v in per_residue]
                    
                    if overall is None:
                        overall = sum(per_residue) / len(per_residue)
                    
                    return overall, per_residue
                
            except Exception as e:
                logger.warning("Failed to parse confidence file", error=str(e))
        
        logger.warning("No confidence file found, using default values")
        return 0.0, [0.0] * sequence_length
    
    def _parse_pdb_coordinates(self, pdb_string: str) -> List[AtomCoordinate]:
        """Parse PDB string into coordinate objects."""
        coordinates = []
        
        for line in pdb_string.split("\n"):
            if line.startswith("ATOM") or line.startswith("HETATM"):
                try:
                    coord = AtomCoordinate(
                        atom_name=line[12:16].strip(),
                        residue_name=line[17:20].strip(),
                        residue_number=int(line[22:26]),
                        chain_id=line[21],
                        x=float(line[30:38]),
                        y=float(line[38:46]),
                        z=float(line[46:54]),
                        element=line[76:78].strip() if len(line) > 76 else "",
                        b_factor=float(line[60:66]) if len(line) > 66 else 0.0,
                    )
                    coordinates.append(coord)
                except (ValueError, IndexError) as e:
                    logger.debug("Failed to parse PDB line", line=line[:50], error=str(e))
        
        return coordinates
    
    def get_model_info(self) -> Dict[str, Any]:
        """Get information about the Boltz service."""
        return {
            "cache_dir": str(self.cache_dir),
            "output_dir": str(self.output_dir),
            "accelerator": self.accelerator,
            "use_msa_server": self.use_msa_server,
            "use_potentials": self.use_potentials,
            "recycling_steps": self.recycling_steps,
            "sampling_steps": self.sampling_steps,
            "diffusion_samples": self.diffusion_samples,
        }