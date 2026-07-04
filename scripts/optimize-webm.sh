#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/optimize-webm.sh [options] <input.webm>

Options:
  -c, --crf <value>      VP9 CRF value. Lower is larger/higher quality. Default: 34.
  -o, --output <path>    Output file. Default: <input>.optimized.webm.
      --replace          Replace the input file atomically.
      --keep-audio       Copy any audio tracks. Default: strip audio.
  -h, --help             Show this help.

Environment:
  FFMPEG                 Path to ffmpeg. Default: first ffmpeg on PATH.
  FFPROBE                Path to ffprobe. Optional; used for before/after metadata.

Example:
  scripts/optimize-webm.sh --replace docs/media/screencasts/page-topics-hierarchy.webm
  scripts/optimize-webm.sh --crf 32 -o /tmp/output.webm input.webm
EOF
}

find_command() {
  local var_name="$1"
  local default_name="$2"
  local configured="${!var_name:-}"

  if [[ -n "$configured" ]]; then
    if [[ -x "$configured" ]]; then
      printf '%s\n' "$configured"
      return 0
    fi
    printf 'error: %s is set but is not executable: %s\n' "$var_name" "$configured" >&2
    return 1
  fi

  command -v "$default_name" 2>/dev/null || true
}

format_bytes() {
  local bytes="$1"
  node -e "const b = Number(process.argv[1]); console.log(new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(b / 1024 / 1024) + ' MB');" "$bytes"
}

crf=34
input=''
output=''
replace=false
keep_audio=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--crf)
      [[ $# -ge 2 ]] || { printf 'error: %s requires a value\n' "$1" >&2; exit 2; }
      crf="$2"
      shift 2
      ;;
    -o|--output)
      [[ $# -ge 2 ]] || { printf 'error: %s requires a path\n' "$1" >&2; exit 2; }
      output="$2"
      shift 2
      ;;
    --replace)
      replace=true
      shift
      ;;
    --keep-audio)
      keep_audio=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      printf 'error: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$input" ]]; then
        printf 'error: multiple input files provided: %s and %s\n' "$input" "$1" >&2
        exit 2
      fi
      input="$1"
      shift
      ;;
  esac
done

if [[ -z "$input" ]]; then
  usage >&2
  exit 2
fi

if [[ ! -f "$input" ]]; then
  printf 'error: input file does not exist: %s\n' "$input" >&2
  exit 1
fi

if ! [[ "$crf" =~ ^[0-9]+$ ]] || (( crf < 0 || crf > 63 )); then
  printf 'error: CRF must be an integer from 0 to 63, got: %s\n' "$crf" >&2
  exit 2
fi

if [[ -n "$output" && "$replace" == true ]]; then
  printf 'error: use either --output or --replace, not both\n' >&2
  exit 2
fi

ffmpeg_bin="$(find_command FFMPEG ffmpeg)"
if [[ -z "$ffmpeg_bin" ]]; then
  cat >&2 <<'EOF'
error: ffmpeg was not found.

Install ffmpeg, put it on PATH, or run with FFMPEG=/path/to/ffmpeg.
EOF
  exit 1
fi

ffprobe_bin="$(find_command FFPROBE ffprobe)"

input_dir="$(cd "$(dirname "$input")" && pwd)"
input_base="$(basename "$input")"
input_abs="$input_dir/$input_base"

if [[ "$replace" == true ]]; then
  output_abs="$input_abs"
else
  if [[ -z "$output" ]]; then
    output="${input_abs%.webm}.optimized.webm"
  fi
  mkdir -p "$(dirname "$output")"
  output_abs="$(cd "$(dirname "$output")" && pwd)/$(basename "$output")"
fi

tmp_output="$(mktemp "$input_dir/.${input_base}.optimized.XXXXXX.webm")"
trap 'rm -f "$tmp_output"' EXIT

before_size="$(wc -c < "$input_abs" | tr -d ' ')"

if [[ -n "$ffprobe_bin" ]]; then
  printf 'Before:\n'
  "$ffprobe_bin" -hide_banner -v error \
    -select_streams v:0 -count_frames \
    -show_entries stream=codec_name,width,height,nb_read_frames \
    -show_entries format=duration,size,bit_rate \
    -of default=noprint_wrappers=1 "$input_abs" || true
  printf '\n'
fi

audio_args=(-an)
if [[ "$keep_audio" == true ]]; then
  audio_args=(-map 0:a? -c:a copy)
fi

"$ffmpeg_bin" -hide_banner -loglevel warning -stats -y -i "$input_abs" \
  -map 0:v:0 \
  -c:v libvpx-vp9 \
  -crf "$crf" \
  -b:v 0 \
  -deadline good \
  -cpu-used 4 \
  -row-mt 1 \
  -pix_fmt yuv420p \
  "${audio_args[@]}" \
  "$tmp_output"

mv "$tmp_output" "$output_abs"
trap - EXIT

after_size="$(wc -c < "$output_abs" | tr -d ' ')"
saved=$(( before_size - after_size ))

printf '\nWrote: %s\n' "$output_abs"
printf 'Size:  %s -> %s' "$(format_bytes "$before_size")" "$(format_bytes "$after_size")"
if (( saved >= 0 )); then
  printf ' (saved %s)\n' "$(format_bytes "$saved")"
else
  printf ' (increased %s)\n' "$(format_bytes "$((-saved))")"
fi

if [[ -n "$ffprobe_bin" ]]; then
  printf '\nAfter:\n'
  "$ffprobe_bin" -hide_banner -v error \
    -select_streams v:0 -count_frames \
    -show_entries stream=codec_name,width,height,nb_read_frames \
    -show_entries format=duration,size,bit_rate \
    -of default=noprint_wrappers=1 "$output_abs" || true
fi
