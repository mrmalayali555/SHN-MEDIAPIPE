# Indian Sign Language (ISL) Data Repository

**Storage & Streaming Policy:**
To protect local disk space and avoid downloading gigabytes of video to local hardware, EyeVoice connects to Hugging Face Hub (`Exploration-Lab/CISLR`, `manojkumarcs/INCLUDE_Dataset`, `kirandevraj/ISL-Fingerspelling`, `Exploration-Lab/iSign`) via **remote streaming (`load_dataset(..., streaming=True)`)** and the **Dataset Viewer API**.

## Directory Layout
- `raw/`: Manifest references and streaming endpoints for raw external videos (no monolithic video binaries stored locally).
- `processed/`: Compact extracted MediaPipe coordinate features and tokenized gloss sequences.
- `annotations/`: Linguistic ISLRTC annotations, phonological parameters, and translation alignments.
- `metadata/`: Schema descriptors, class indices, and dataset catalogs.
- `splits/`: Signer-independent train / validation / test partitioning manifests.

## Cloud Execution for Heavy Model Training
For full batch model retraining on complete 50GB+ video corpora, launch a GitHub Codespace or cloud GPU instance (e.g., via `scripts/train_codespace.sh`) rather than training on local laptop hardware.
