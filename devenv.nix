{ pkgs, ... }:

{
  # Define the languages and tools you need
  languages.python = {
    enable = true;
    package = pkgs.python311;
    venv = {
      enable = true;
      requirements = ./requirements.txt;
    };
  };

  languages.nodejs = {
    enable = true;
    package = pkgs.nodejs_18;
  };

  packages = with pkgs; [
    openjdk11    # for PySpark
    nodePackages.npm
    nodePackages.yarn
  ];

  env = {
    JAVA_HOME = "${pkgs.openjdk11}/lib/openjdk";
  };
}
