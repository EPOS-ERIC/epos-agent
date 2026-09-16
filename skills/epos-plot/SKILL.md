---
name: epos-plot
description: Generates deterministic, high-quality scientific plots (maps, seismicity, WMS overlays) for EPOS data without improvising unstructured code.
---

# Instructions
You are an expert seismological and geophysics visualization agent. You must generate high-quality Python plotting scripts for EPOS datasets, using strict, deterministic templates to save tokens. Do not improvise new plotting logic from scratch.

## 1. Asking for Requirements
If the user requests a plot but does not provide enough information (e.g., area of interest, type of map, or specific data filters), you MUST ask 1-3 concise questions before writing code.
- "Quale area geografica vuoi plottare (es. Etna, Vesuvio, scala nazionale)?"
- "Vuoi visualizzare solo i terremoti o aggiungere un overlay WMS (es. Hazard map)?"

## 2. Using Deterministic Templates
When writing Python code (e.g., using `epos_run_python` or a local script), you must adapt the following predefined templates. 

### Template 1: Folium Map with WMS and Seismicity
Use this template when the user wants an interactive map, especially with an EPOS WMS service overlay and/or earthquake points.

```python
import folium
import pandas as pd

def plot_interactive_map(csv_path, output_path, wms_url=None, wms_layers=None):
    # Initialize Map (centered on Etna by default, adjust based on data)
    m = folium.Map(location=[37.75, 15.00], zoom_start=10, control_scale=True)
    
    # Add Base Maps
    folium.TileLayer('OpenStreetMap').add_to(m)
    folium.TileLayer('cartodbpositron', name='Light Map').add_to(m)
    
    # Add WMS Layer if provided (e.g., gemhazard)
    if wms_url and wms_layers:
        folium.raster_layers.WmsTileLayer(
            url=wms_url,
            layers=wms_layers,
            fmt='image/png',
            transparent=True,
            name=wms_layers,
            version='1.3.0',
            overlay=True,
            control=True,
        ).add_to(m)
        
    # Load and Add Earthquake Data
    try:
        df = pd.read_csv(csv_path)
        # Assuming columns: latitude, longitude, magnitude, depth
        if not df.empty and 'latitude' in df.columns and 'longitude' in df.columns:
            for _, row in df.iterrows():
                mag = row.get('magnitude', 3.0)
                folium.CircleMarker(
                    location=[row['latitude'], row['longitude']],
                    radius=max(mag * 2, 2),
                    color='red',
                    fill=True,
                    fill_color='red',
                    fill_opacity=0.6,
                    popup=f"Mag: {mag}<br>Depth: {row.get('depth', 'N/A')} km"
                ).add_to(m)
    except Exception as e:
        print(f"Error loading seismic data: {e}")
        
    folium.LayerControl().add_to(m)
    m.save(output_path)
    print(f"Map saved successfully to {output_path}")

# Example Usage:
# plot_interactive_map('earthquakes.csv', 'map.html', wms_url='http://efehrmaps.ethz.ch/cgi-bin/mapserv?MAP=/var/www/mapfile/sharehazard.01.map', wms_layers='hmap457')
```

### Template 2: Static Matplotlib Plot (Time-Series / Depth Profile)
Use this template for static analytical charts.

```python
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

def plot_static_seismicity(csv_path, output_path):
    df = pd.read_csv(csv_path)
    
    # Convert time string to datetime
    if 'time' in df.columns:
        df['time'] = pd.to_datetime(df['time'])
        
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(15, 6))
    
    # Plot 1: Magnitude over Time
    if 'time' in df.columns and 'magnitude' in df.columns:
        sns.scatterplot(data=df, x='time', y='magnitude', ax=ax1, alpha=0.6, color='orange')
        ax1.set_title('Magnitude over Time')
        ax1.tick_params(axis='x', rotation=45)
    
    # Plot 2: Depth Profile
    if 'longitude' in df.columns and 'depth' in df.columns:
        sns.scatterplot(data=df, x='longitude', y='depth', hue='magnitude', palette='viridis', ax=ax2)
        ax2.invert_yaxis()
        ax2.set_title('W-E Depth Profile')
        
    plt.tight_layout()
    plt.savefig(output_path, dpi=300)
    plt.close()
    print(f"Plot saved to {output_path}")
```

## 3. Strict Rules for the Agent
- ALWAYS rely on these templates instead of writing plotting logic from scratch.
- MINIMIZE token generation by only outputting the adapted code. Do not output lengthy explanations of the matplotlib or folium parameters unless asked.
- NEVER invent WMS URLs or layers. If you do not have them from `epos-search` or `epos-service-access`, use a default or ask the user. 
- You can use the `http://efehrmaps.ethz.ch/cgi-bin/mapserv?MAP=/var/www/mapfile/sharehazard.01.map&` WMS endpoint for hazard maps (e.g., layers `hmap457` to `hmap546`).
