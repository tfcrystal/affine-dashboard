# Easy script: print total size of Hugging Face model using web scraping
# Works on Ubuntu/Linux

import requests
import re

def get_model_total_size_gb(model_name):
    """
    Scrape Hugging Face model page to get total size.
    Returns size in GB as float.
    Optimized for speed - tries main page first.
    """
    # Try main model page first (fastest, most direct)
    url = f"https://huggingface.co/{model_name}"
    size_gb = scrape_size_from_url(url, model_name)
    if size_gb is not None:
        return size_gb
    
    # Fallback to files page if main page doesn't have it
    url = f"https://huggingface.co/{model_name}/tree/main"
    size_gb = scrape_size_from_url(url, model_name)
    if size_gb is not None:
        return size_gb
    
    return None

def scrape_size_from_url(url, model_name):
    """
    Scrape a specific URL to find the total model size.
    Returns size in GB as float, or None if not found.
    """
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
    }
    
    try:
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        
        html_text = response.text
        
        # Quick regex search for GB patterns - find largest size (likely the total)
        all_sizes = re.findall(r'(\d+\.?\d*)\s*GB', html_text, re.IGNORECASE)
        if all_sizes:
            sizes = [float(s) for s in all_sizes if float(s) > 1.0]  # Filter small sizes
            if sizes:
                return max(sizes)  # Return largest size found (total repository size)
        
        return None
        
    except Exception as e:
        # Use stderr for errors to avoid breaking JSON output when called from batch script
        import sys
        print(f"Error scraping {url}: {e}", file=sys.stderr)
        return None

if __name__ == "__main__":
    import time
    
    # Test with different models
    models = [
        "Sota26/Affine-6-5HpqTamztoLsVqrHKv1aY4auSQKerdLBKHHTfvgebqGynTeq",  # Original test
    ]
    
    for model in models:
        start_time = time.time()
        size_gb = get_model_total_size_gb(model)
        elapsed = time.time() - start_time
        
        if size_gb is not None:
            mb_size = size_gb * 1024
            bytes_size = size_gb * (1024**3)
            print(f"Model: {model}")
            print(f"Total Size: {int(bytes_size)} bytes, {mb_size:.2f} MB, {size_gb:.2f} GB")
            print(f"Time: {elapsed:.2f} seconds")
        else:
            print(f"Model: {model}")
            print("Failed to get total size from scraping")
            print(f"Time: {elapsed:.2f} seconds")
        print("-" * 60)
