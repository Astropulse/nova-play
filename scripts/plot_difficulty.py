import matplotlib.pyplot as plt
import numpy as np
import os

# Tunable Difficulty Constants (Synched with PlayingState in playingState.js)
WARMUP_TIME = 240
RAMP_TIME = 240 # Transition happens at 4m
EXPONENT = 1.52
GAIN = 0.000366
STEADY_RATE = 0.014

def calculate_difficulty(t):
    if t <= RAMP_TIME:
        # Phase 1: Convex Ramp (Power Curve)
        return 1.0 + (GAIN * np.power(t, EXPONENT))
    else:
        # Phase 2: Steady Growth (Linear)
        ramp_max = GAIN * np.power(RAMP_TIME, EXPONENT)
        steady_time = t - RAMP_TIME
        return 1.0 + ramp_max + (STEADY_RATE * steady_time)

def generate_plot():
    total_minutes = 10
    total_seconds = total_minutes * 60
    t_values = np.linspace(0, total_seconds, 1000)
    y_values = [calculate_difficulty(t) for t in t_values]

    plt.figure(figsize=(10, 6))
    plt.plot(t_values / 60, y_values, label='Difficulty Scale', color='#FF4500', linewidth=2)
    plt.axvline(x=4, color='gray', linestyle='--', alpha=0.5)
    plt.text(4.1, 1.1, '4m: Ramp Start', verticalalignment='bottom')

    plt.title('Difficulty Scaling Progression (10 Minute Window)', fontsize=14)
    plt.xlabel('Time (Minutes)', fontsize=12)
    plt.ylabel('Difficulty Multiplier', fontsize=12)
    plt.grid(True, which='both', linestyle=':', alpha=0.7)
    plt.ylim(1.0, 10)
    plt.xlim(0, 10)
    plt.legend()

    # Save to the same directory as the script
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output_path = os.path.join(script_dir, 'difficulty_curve.png')
    
    plt.savefig(output_path, dpi=150)
    print(f"Graph saved successfully to: {output_path}")

if __name__ == "__main__":
    generate_plot()
