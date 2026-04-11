import matplotlib.pyplot as plt
import numpy as np
import os
import re

# --- Project Paths ---
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLAYING_STATE_PATH = os.path.join(BASE_DIR, 'src', 'states', 'playingState.js')
ENEMY_PATH = os.path.join(BASE_DIR, 'src', 'entities', 'enemy.js')
CRUSHER_PATH = os.path.join(BASE_DIR, 'src', 'entities', 'asteroidCrusher.js')
STARCORE_PATH = os.path.join(BASE_DIR, 'src', 'entities', 'starcore.js')
KNOWLEDGE_PATH = os.path.join(BASE_DIR, 'src', 'entities', 'knowledgeEvent.js')

class GameDataScanner:
    def __init__(self):
        self.constants = {}
        self.formulas = {}

    def scan_all(self):
        self._scan_playing_state()
        self._scan_health_formulas()
        self._scan_combat_formulas()

    def _scan_playing_state(self):
        with open(PLAYING_STATE_PATH, 'r') as f:
            content = f.read()
            
        # Extract difficulty constants
        self.constants['RAMP_TIME'] = float(re.search(r'this\.difficultyRampTime\s*=\s*([\d\.]+)', content).group(1))
        self.constants['EXPONENT'] = float(re.search(r'this\.difficultyExponent\s*=\s*([\d\.]+)', content).group(1))
        self.constants['GAIN'] = float(re.search(r'this\.difficultyGain\s*=\s*([\d\.]+)', content).group(1))
        self.constants['STEADY_RATE'] = float(re.search(r'this\.difficultySteadyRate\s*=\s*([\d\.]+)', content).group(1))
        
        print(f"Scanned Difficulty Constants: {self.constants}")

    def _scan_health_formulas(self):
        # 1. Standard Enemy
        with open(ENEMY_PATH, 'r') as f:
            content = f.read()
            # Find the first health definition in constructor (standard Enemy)
            std_match = re.search(r'class Enemy.*?this\.health\s*=\s*Math\.ceil\((.*?)\);', content, re.DOTALL)
            if std_match:
                self.formulas['standard_enemy_hp'] = self._clean_formula(std_match.group(1))

            # Find KamikazeEnemy health
            kami_match = re.search(r'class KamikazeEnemy.*?this\.health\s*=\s*Math\.ceil\((.*?)\);', content, re.DOTALL)
            if kami_match:
                self.formulas['kamikaze_enemy_hp'] = self._clean_formula(kami_match.group(1))

            # Find CthulhuEnemy health
            cthulhu_match = re.search(r'class CthulhuEnemy.*?this\.health\s*=\s*Math\.ceil\((.*?)\);', content, re.DOTALL)
            if cthulhu_match:
                self.formulas['cthulhu_enemy_hp'] = self._clean_formula(cthulhu_match.group(1))

        # 2. Asteroid Crusher
        with open(CRUSHER_PATH, 'r') as f:
            content = f.read()
            crush_match = re.search(r'this\.health\s*=\s*(.*?);', content)
            if crush_match:
                self.formulas['asteroid_crusher_hp'] = self._clean_formula(crush_match.group(1))

        # 3. Starcore
        with open(STARCORE_PATH, 'r') as f:
            content = f.read()
            star_match = re.search(r'this\.health\s*=\s*(.*?);', content)
            if star_match:
                self.formulas['starcore_hp'] = self._clean_formula(star_match.group(1))

        # 4. Knowledge Event (maxBossHealth)
        with open(KNOWLEDGE_PATH, 'r') as f:
            content = f.read()
            know_match = re.search(r'this\.maxBossHealth\s*=\s*(.*?);', content)
            if know_match:
                self.formulas['knowledge_boss_hp'] = self._clean_formula(know_match.group(1))

        # 5. Base Boss Class
        BOSS_PATH = os.path.join(BASE_DIR, 'src', 'entities', 'boss.js')
        if os.path.exists(BOSS_PATH):
            with open(BOSS_PATH, 'r') as f:
                content = f.read()
                boss_match = re.search(r'this\.health\s*=\s*(.*?);', content)
                if boss_match:
                    self.formulas['generic_boss_hp'] = self._clean_formula(boss_match.group(1))

    def _scan_combat_formulas(self):
        with open(ENEMY_PATH, 'r') as f:
            content = f.read()
            
            # Speed Scale (usually near stats section)
            speed_match = re.search(r'const speedScale\s*=\s*(.*?);', content)
            if speed_match:
                self.constants['enemy_speed_scale_form'] = self._clean_formula(speed_match.group(1))

            # Base Speed (with potential Math.min)
            bs_match = re.search(r'this\.baseSpeed\s*=\s*(.*?);', content)
            if bs_match:
                # Replace the random range with its average (360)
                form = bs_match.group(1).replace('(320+Math.random()*80)', '360').replace('(320 + Math.random() * 80)', '360')
                form = form.replace('speedScale', '('+self.constants.get('enemy_speed_scale_form', '1')+')')
                self.formulas['enemy_avg_speed'] = self._clean_formula(form)

            # Turn Speed (with potential Math.min)
            ts_match = re.search(r'this\.turnSpeed\s*=\s*(.*?);', content)
            if ts_match:
                # Replace random with 0.5
                turn_form = re.search(r'const turnScale\s*=\s*(.*?);', content)
                t_scale = self._clean_formula(turn_form.group(1)) if turn_form else '1'
                form = ts_match.group(1).replace('(6.5+Math.random()*1.0)', '7.0').replace('(6.5 + Math.random() * 1.0)', '7.0')
                form = form.replace('turnScale', '('+t_scale+')')
                self.formulas['enemy_avg_turn_speed'] = self._clean_formula(form)

            # Damage (in shoot method)
            damage_match = re.search(r'let damage\s*=\s*(.*?);', content)
            if damage_match:
                self.formulas['enemy_damage'] = self._clean_formula(damage_match.group(1))

        print(f"Scanned Extra Formulas: { {k: v for k, v in self.formulas.items() if 'hp' not in k} }")

    def _clean_formula(self, formula):
        # Convert JS difficultyScale refs to Python 'd'
        formula = formula.replace('this.difficultyScale', 'd').replace('difficultyScale', 'd')
        # Handle the new curvedDifficultyScale getter
        formula = formula.replace('this.curvedDifficultyScale', '(d**0.6)').replace('curvedDifficultyScale', '(d**0.6)')
        # Handle JS Math functions
        formula = formula.replace('Math.ceil(', '(').replace('Math.floor(', '(')
        formula = formula.replace('Math.pow(', 'pow(').replace('Math.min(', 'min(')
        # Handle simple multiplications/additions
        formula = formula.replace('this.damageMult', '1.0') # Assume baseline
        return formula

def calculate_difficulty(t, constants):
    ramp_time = constants['RAMP_TIME']
    exponent = constants['EXPONENT']
    gain = constants['GAIN']
    rate = constants['STEADY_RATE']

    if t <= ramp_time:
        return 1.0 + (gain * np.power(t, exponent))
    else:
        ramp_max = gain * np.power(ramp_time, exponent)
        steady_time = t - ramp_time
        return 1.0 + ramp_max + (rate * steady_time)

def evaluate_formula(formula, d):
    try:
        # Wrap in another paren to be safe
        return eval(f"({formula})", {"d": d, "np": np})
    except Exception as e:
        return 0

def generate_plot():
    scanner = GameDataScanner()
    scanner.scan_all()

    total_minutes = 30
    total_seconds = total_minutes * 60
    t_values = np.linspace(0, total_seconds, 1200) # Increased resolution for 20m
    
    # Calculate Difficulty
    d_values = [calculate_difficulty(t, scanner.constants) for t in t_values]
    
    # Calculate Data
    results = {name: [evaluate_formula(form, d) for d in d_values] for name, form in scanner.formulas.items()}

    # Create subplot layout - Now 4 panels
    fig, axes = plt.subplots(4, 1, figsize=(10, 18), sharex=True)
    plt.subplots_adjust(hspace=0.3)
    (ax1, ax2, ax3, ax4) = axes

    # 1. Difficulty Plot
    ax1.plot(t_values / 60, d_values, label='Difficulty (x)', color='#FF4500', linewidth=2.5)
    ax1.axvline(x=scanner.constants['RAMP_TIME']/60, color='gray', linestyle='--', alpha=0.5)
    ax1.set_title('Game Difficulty Progression', fontsize=14, fontweight='bold')
    ax1.set_ylabel('Multiplier', fontsize=12)
    ax1.grid(True, linestyle=':', alpha=0.6)
    ax1.legend(loc='upper left')

    # 2. Enemy Health Plot
    ax2.plot(t_values / 60, results.get('standard_enemy_hp', []), label='Standard Enemy HP', color='#4CAF50', linewidth=2)
    ax2.plot(t_values / 60, results.get('kamikaze_enemy_hp', []), label='Kamikaze Enemy HP', color='#FF9800', linewidth=2)
    if 'cthulhu_enemy_hp' in results:
        ax2.plot(t_values / 60, results['cthulhu_enemy_hp'], label='Cthulhu Enemy HP', color='#795548', linewidth=2, linestyle=':')
    ax2.set_title('Enemy Health Scaling', fontsize=12)
    ax2.set_ylabel('Health (HP)', fontsize=12)
    ax2.grid(True, linestyle=(':'), alpha=0.6)
    ax2.legend(loc='upper left')

    # 3. Boss Health Plot
    boss_map = {'starcore_hp': ('Starcore', '#9C27B0'), 
                'asteroid_crusher_hp': ('Asteroid Crusher', '#2196F3'), 
                'knowledge_boss_hp': ('Knowledge Boss', '#F44336'),
                'generic_boss_hp': ('Generic Boss Base', '#9E9E9E')}
    for key, (label, color) in boss_map.items():
        if key in results:
            ls = '--' if 'generic' in key else '-'
            ax3.plot(t_values / 60, results[key], label=label, color=color, linewidth=2, linestyle=ls)
    ax3.set_title('Boss Health Comparison', fontsize=12)
    ax3.set_ylabel('Health (HP)', fontsize=12)
    ax3.grid(True, linestyle=':', alpha=0.6)
    ax3.legend(loc='upper left')

    # 4. Combat Lethality Plot (Speed, Turn, Damage)
    if 'enemy_damage' in results:
        ax4_right = ax4.twinx()
        l1 = ax4.plot(t_values / 60, results['enemy_damage'], label='Base Damage', color='#E91E63', linewidth=2)
        ax4.set_ylabel('Damage', fontsize=12, color='#E91E63')
        ax4.tick_params(axis='y', labelcolor='#E91E63')
        
        # Speed Curve (Capped)
        if 'enemy_avg_speed' in results:
            l2 = ax4_right.plot(t_values / 60, results['enemy_avg_speed'], label='Avg Velocity', color='#00BCD4', linewidth=2)
            ax4_right.set_ylabel('Velocity (px/s)', fontsize=12, color='#00BCD4')
            ax4_right.tick_params(axis='y', labelcolor='#00BCD4')
            
        # Turn Speed (Capped) - Secondary axis might be too much, let's use a subtle line or just note it
        if 'enemy_avg_turn_speed' in results:
            ax4_far_right = ax4.twinx()
            ax4_far_right.spines['right'].set_position(('outward', 60))
            l3 = ax4_far_right.plot(t_values / 60, results['enemy_avg_turn_speed'], label='Turn Speed', color='#FFEB3B', linewidth=1.5, linestyle='--')
            ax4_far_right.set_ylabel('Turn (rad/s)', fontsize=12, color='#FBC02D')
            ax4_far_right.tick_params(axis='y', labelcolor='#FBC02D')
        
    ax4.set_title('Enemy Combat Lethality (Capped Speed/Turn & Damage)', fontsize=12)
    ax4.set_xlabel('Time (Minutes)', fontsize=12)
    ax4.grid(True, linestyle=':', alpha=0.6)
    
    # Combined legend
    lns = l1 + (l2 if 'enemy_avg_speed' in results else []) + (l3 if 'enemy_avg_turn_speed' in results else [])
    labs = [l.get_label() for l in lns]
    ax4.legend(lns, labs, loc='upper left')

    # Global Formatting
    plt.xlim(0, total_minutes)
    
    # Save to workspace
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output_path = os.path.join(script_dir, 'progression_plot.png')
    plt.savefig(output_path, dpi=120, bbox_inches='tight')
    print(f"\nSuccess! Full progression plot ({total_minutes}m) saved to: {output_path}")

if __name__ == "__main__":
    generate_plot()
