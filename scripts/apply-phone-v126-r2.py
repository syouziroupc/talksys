from pathlib import Path

base = Path(__file__).with_name('apply-phone-v126.py')
source = base.read_text()
source = source.replace('talksys-phone-noise-v125-r1', 'talksys-phone-noise-vad-v125-r1')
source = source.replace('talksys-phone-noise-v126-r1', 'talksys-phone-noise-vad-v126-r1')
exec(compile(source, str(base), 'exec'), {'__name__': '__main__', '__file__': str(base)})
