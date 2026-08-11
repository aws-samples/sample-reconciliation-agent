output "skills_function_name" {
  description = "Name of the skills-catalog BFF Lambda."
  value       = aws_lambda_function.skills.function_name
}
